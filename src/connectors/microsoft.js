const logger = require('../logger');
const msal = require('@azure/msal-node');
const { getTokens, saveTokens } = require('../tokenStore');
const util = require('util');

// node-fetch v3 ESM interop
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Simple in-memory cache for MSAL instances
const msalAppCache = new Map();

function getAccount(cfg, alias) {
  const accounts = cfg?.providers?.microsoft?.accounts || [];
  return accounts.find(a => a.alias === alias);
}

function makeApp(account) {
  const cacheKey = `${account.clientId}:${account.alias}`;
  
  if (msalAppCache.has(cacheKey)) {
    return msalAppCache.get(cacheKey);
  }

  const config = {
    auth: {
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      authority: `https://login.microsoftonline.com/${account.tenantId || 'common'}`,
    },
    system: {
      loggerOptions: {
        loggerCallback(loglevel, message, containsPii) {
          logger.debug(`[MSAL] ${message}`);
        },
        piiLoggingEnabled: false,
        logLevel: msal.LogLevel.Verbose,
      }
    }
  };

  const app = new msal.ConfidentialClientApplication(config);
  msalAppCache.set(cacheKey, app);
  return app;
}

async function buildAuthUrl(cfg, alias) {
  try {
    const account = getAccount(cfg, alias);
    if (!account) {
      throw new Error(`No Microsoft account found with alias: ${alias}`);
    }

    const app = makeApp(account);
    const scopes = account.scopes || ['Files.Read.All', 'Sites.Read.All', 'Mail.Read'];
    
    const authUrlParams = {
      scopes,
      redirectUri: account.redirectUri,
      state: JSON.stringify({ provider: 'microsoft', alias }),
      prompt: 'select_account'
    };

    return app.getAuthCodeUrl(authUrlParams);
  } catch (error) {
    logger.error('Error building auth URL:', error);
    throw error;
  }
}

async function handleCallback(cfg, code, state) {
  try {
    const stateObj = JSON.parse(state || '{}');
    const alias = stateObj.alias;
    
    if (!alias) {
      throw new Error('Missing alias in OAuth state');
    }

    const account = getAccount(cfg, alias);
    if (!account) {
      throw new Error(`No Microsoft account found with alias: ${alias}`);
    }

    const app = makeApp(account);
    const scopes = account.scopes || ['Files.Read.All', 'Sites.Read.All', 'Mail.Read'];
    
    logger.info('Acquiring token with code...');
    const tokenResponse = await app.acquireTokenByCode({
      code,
      scopes,
      redirectUri: account.redirectUri,
    });

    if (!tokenResponse?.accessToken) {
      throw new Error('No access token in response from Microsoft');
    }

    logger.info('Successfully acquired tokens', {
      hasAccessToken: !!tokenResponse.accessToken,
      hasRefreshToken: !!tokenResponse.refreshToken,
      expiresOn: tokenResponse.expiresOn?.toISOString()
    });

    // Save tokens
    await saveTokens('microsoft', alias, {
      accessToken: tokenResponse.accessToken,
      refreshToken: tokenResponse.refreshToken,
      expiresAt: tokenResponse.expiresOn?.getTime(),
      account: tokenResponse.account,
      scopes: tokenResponse.scopes || scopes
    });

    return { success: true, alias };

  } catch (error) {
    logger.error('Error in Microsoft OAuth callback:', error.message, {
      stack: error.stack,
      state
    });
    throw error;
  }
}

async function getAccessToken(account) {
  const accountLabel = `Microsoft account '${account.alias}'`;
  
  try {
    // First try to get from saved tokens
    logger.debug(`${accountLabel}: Getting tokens from store...`);
    const savedTokens = await getTokens('microsoft', account.alias);
    
    if (savedTokens) {
      logger.debug(`${accountLabel}: Found saved tokens, checking validity...`, {
        hasAccessToken: !!savedTokens.accessToken,
        hasRefreshToken: !!savedTokens.refreshToken,
        expiresAt: savedTokens.expiresAt ? new Date(savedTokens.expiresAt).toISOString() : 'none',
        now: new Date().toISOString()
      });
      
      // Check if we have a valid access token
      if (savedTokens.accessToken) {
        // Check if token is still valid (with 5 minute buffer)
        const expiresAt = savedTokens.expiresAt || 0;
        const now = Date.now();
        const buffer = 300000; // 5 minutes
        
        if (expiresAt > (now + buffer)) {
          logger.debug(`${accountLabel}: Using valid saved access token (expires: ${new Date(expiresAt).toISOString()})`);
          return savedTokens.accessToken;
        } else {
          logger.debug(`${accountLabel}: Access token expired at ${new Date(expiresAt).toISOString()}`);
        }
      }
      
      // Try to refresh if we have a refresh token
      if (savedTokens.refreshToken) {
        try {
          logger.info(`${accountLabel}: Attempting to refresh access token...`);
          const app = makeApp(account);
          const scopes = savedTokens.scopes || ['Files.Read.All', 'Sites.Read.All', 'Mail.Read'];
          
          logger.debug(`${accountLabel}: Using scopes for refresh:`, scopes);
          
          const response = await app.acquireTokenByRefreshToken({
            refreshToken: savedTokens.refreshToken,
            scopes: scopes
          });

          if (response?.accessToken) {
            logger.info(`${accountLabel}: Successfully refreshed access token`);
            
            // Prepare new token data
            const newTokenData = {
              accessToken: response.accessToken,
              refreshToken: response.refreshToken || savedTokens.refreshToken, // Preserve refresh token if not returned
              expiresAt: response.expiresOn?.getTime() || (Date.now() + 3600000), // Default to 1 hour if not provided
              scopes: response.scopes || scopes,
              account: savedTokens.account // Preserve account info
            };
            
            logger.debug(`${accountLabel}: Saving refreshed tokens`, {
              expiresAt: new Date(newTokenData.expiresAt).toISOString(),
              scopes: newTokenData.scopes
            });
            
            // Save the new tokens
            await saveTokens('microsoft', account.alias, newTokenData);
            
            return response.accessToken;
          } else {
            logger.warn(`${accountLabel}: No access token in refresh response`);
          }
        } catch (refreshError) {
          logger.error(`${accountLabel}: Failed to refresh token:`, {
            message: refreshError.message,
            stack: refreshError.stack,
            errorDetails: refreshError
          });
          // Continue to return null to trigger re-authentication
        }
      } else {
        logger.warn(`${accountLabel}: No refresh token available`);
      }
    } else {
      logger.warn(`${accountLabel}: No saved tokens found`);
    }
    
    logger.warn(`${accountLabel}: No valid access token available, re-authentication required`);
    return null;

  } catch (error) {
    logger.error(`${accountLabel}: Error in getAccessToken:`, {
      message: error.message,
      stack: error.stack,
      errorDetails: error
    });
    return null;
  }
}

async function searchOneDrive(token, alias, query) {
  const accountLabel = `Microsoft account '${alias}'`;
  try {
    const searchQuery = query ? `search(q='${encodeURIComponent(query)}')` : '';
    const endpoint = `https://graph.microsoft.com/v1.0/me/drive/root/${searchQuery}?$top=50&$select=id,name,webUrl,lastModifiedDateTime,size,file`;
    
    logger.debug(`${accountLabel}: Searching OneDrive`, { endpoint });
    
    const startTime = Date.now();
    const response = await fetch(endpoint, {
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    const responseTime = Date.now() - startTime;
    const responseStatus = response.status;
    const responseStatusText = response.statusText;
    
    if (!response.ok) {
      let errorDetails = '';
      try {
        errorDetails = await response.text();
      } catch (e) {
        errorDetails = 'Could not parse error response';
      }
      
      logger.error(`${accountLabel}: OneDrive search failed`, {
        status: responseStatus,
        statusText: responseStatusText,
        responseTime: `${responseTime}ms`,
        error: errorDetails,
        query
      });
      
      throw new Error(`OneDrive search failed (${responseStatus}): ${responseStatusText}`);
    }

    const data = await response.json();
    const results = data.value || [];
    
    logger.debug(`${accountLabel}: OneDrive search completed`, {
      resultCount: results.length,
      responseTime: `${responseTime}ms`,
      query
    });
    
    return results.map(item => ({
      id: `onedrive:${item.id}`,
      title: item.name,
      url: item.webUrl,
      type: item.file ? 'file' : 'folder',
      source: 'microsoft-onedrive',
      account: alias,
      lastModified: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime).getTime() : null,
      size: item.size || 0
    }));

  } catch (error) {
    logger.error(`${accountLabel}: Error in OneDrive search`, {
      message: error.message,
      stack: error.stack,
      query
    });
    return [];
  }
}

async function searchSharePoint(token, alias, query) {
  const accountLabel = `Microsoft account '${alias}'`;
  
  if (!query?.trim()) {
    logger.debug(`${accountLabel}: Empty query for SharePoint search`);
    return [];
  }
  
  try {
    const endpoint = 'https://graph.microsoft.com/v1.0/search/query';
    const requestBody = {
      requests: [{
        entityTypes: ['driveItem'],
        query: { 
          queryString: query,
          queryTemplate: query.includes(':') ? null : `{searchTerms}*`
        },
        from: 0,
        size: 50,
        fields: ['id', 'name', 'webUrl', 'lastModifiedDateTime', 'size', 'file']
      }]
    };
    
    logger.debug(`${accountLabel}: Searching SharePoint`, { 
      endpoint,
      query,
      requestBody: JSON.stringify(requestBody, null, 2)
    });
    
    const startTime = Date.now();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const responseTime = Date.now() - startTime;
    const responseStatus = response.status;
    const responseStatusText = response.statusText;
    
    if (!response.ok) {
      let errorDetails = '';
      try {
        errorDetails = await response.text();
      } catch (e) {
        errorDetails = 'Could not parse error response';
      }
      
      logger.error(`${accountLabel}: SharePoint search failed`, {
        status: responseStatus,
        statusText: responseStatusText,
        responseTime: `${responseTime}ms`,
        error: errorDetails,
        query
      });
      
      // If it's a 403, the app might not have the right permissions
      if (responseStatus === 403) {
        logger.error(`${accountLabel}: SharePoint access denied. Make sure the app has 'Sites.Read.All' permission.`);
      }
      
      throw new Error(`SharePoint search failed (${responseStatus}): ${responseStatusText}`);
    }

    const data = await response.json();
    const hits = data.value?.[0]?.hitsContainers?.[0]?.hits || [];
    
    logger.debug(`${accountLabel}: SharePoint search completed`, {
      resultCount: hits.length,
      responseTime: `${responseTime}ms`,
      query
    });
    
    return hits.map(hit => {
      const item = hit.resource || {};
      return {
        id: `sharepoint:${item.id || hit.hitId}`,
        title: item.name || item.title || 'SharePoint Item',
        url: item.webUrl,
        type: item.file ? 'file' : 'folder',
        source: 'microsoft-sharepoint',
        account: alias,
        lastModified: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime).getTime() : null,
        size: item.size || 0
      };
    });

  } catch (error) {
    logger.error(`${accountLabel}: Error in SharePoint search`, {
      message: error.message,
      stack: error.stack,
      query
    });
    return [];
  }
}

async function searchOutlook(token, alias, query) {
  const accountLabel = `Microsoft account '${alias}'`;
  
  if (!query?.trim()) {
    logger.debug(`${accountLabel}: Empty query for Outlook search`);
    return [];
  }
  
  try {
    // First search for relevant messages
    const messagesEndpoint = `https://graph.microsoft.com/v1.0/me/messages?$search="attachment:${encodeURIComponent(query)}"&$top=10&$select=id,subject,receivedDateTime`;
    
    logger.debug(`${accountLabel}: Searching Outlook messages`, { 
      endpoint: messagesEndpoint,
      query
    });
    
    const startTime = Date.now();
    const messagesResponse = await fetch(messagesEndpoint, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });

    const messagesResponseTime = Date.now() - startTime;
    
    if (!messagesResponse.ok) {
      let errorDetails = '';
      try {
        errorDetails = await messagesResponse.text();
      } catch (e) {
        errorDetails = 'Could not parse error response';
      }
      
      logger.error(`${accountLabel}: Outlook message search failed`, {
        status: messagesResponse.status,
        statusText: messagesResponse.statusText,
        responseTime: `${messagesResponseTime}ms`,
        error: errorDetails,
        query
      });
      
      // If it's a 403, the app might not have the right permissions
      if (messagesResponse.status === 403) {
        logger.error(`${accountLabel}: Outlook access denied. Make sure the app has 'Mail.Read' permission.`);
      }
      
      throw new Error(`Outlook message search failed (${messagesResponse.status}): ${messagesResponse.statusText}`);
    }

    const messagesData = await messagesResponse.json();
    const results = [];
    const messages = messagesData.value || [];
    
    logger.debug(`${accountLabel}: Found ${messages.length} matching messages`, {
      responseTime: `${messagesResponseTime}ms`
    });

    // Get attachments for each message
    for (const [index, message] of messages.entries()) {
      try {
        const attachmentsEndpoint = `https://graph.microsoft.com/v1.0/me/messages/${message.id}/attachments?$select=id,name,size,contentType`;
        
        logger.debug(`${accountLabel}: Getting attachments for message ${index + 1}/${messages.length}`, {
          messageId: message.id,
          subject: message.subject
        });
        
        const attachmentsResponse = await fetch(attachmentsEndpoint, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
          }
        });

        if (!attachmentsResponse.ok) {
          logger.warn(`${accountLabel}: Failed to get attachments for message ${message.id}`, {
            status: attachmentsResponse.status,
            statusText: attachmentsResponse.statusText
          });
          continue;
        }

        const attachmentsData = await attachmentsResponse.json();
        const attachments = attachmentsData.value || [];
        
        logger.debug(`${accountLabel}: Found ${attachments.length} attachments in message`, {
          messageId: message.id,
          attachmentCount: attachments.length
        });
        
        // Filter attachments that match the query (case insensitive)
        const queryLower = query.toLowerCase();
        const matchingAttachments = attachments.filter(attachment => 
          attachment.name && attachment.name.toLowerCase().includes(queryLower)
        );
        
        for (const attachment of matchingAttachments) {
          results.push({
            id: `outlook:${message.id}:${attachment.id}`,
            title: attachment.name || 'Attachment',
            url: `https://outlook.office.com/mail/id/${message.id}`,
            type: 'file',
            source: 'microsoft-outlook',
            account: alias,
            lastModified: message.receivedDateTime ? new Date(message.receivedDateTime).getTime() : null,
            size: attachment.size || 0,
            mimeType: attachment.contentType
          });
        }
        
      } catch (error) {
        logger.error(`${accountLabel}: Error processing message ${message.id}`, {
          message: error.message,
          stack: error.stack
        });
        // Continue with next message
      }
    }
    
    logger.info(`${accountLabel}: Outlook search completed`, {
      messageCount: messages.length,
      attachmentCount: results.length,
      query
    });

    return results;

  } catch (error) {
    logger.error(`${accountLabel}: Error in Outlook search`, {
      message: error.message,
      stack: error.stack,
      query
    });
    return [];
  }
}

async function searchMicrosoftByName(name, msCfg) {
  const searchStartTime = Date.now();
  const query = name?.trim() || '';
  
  if (!msCfg?.enabled) {
    const warning = 'Microsoft provider is disabled in config';
    logger.warn(warning);
    return [];
  }

  if (!Array.isArray(msCfg.accounts) || !msCfg.accounts.length) {
    const warning = 'No Microsoft accounts configured';
    logger.warn(warning);
    return [];
  }

  logger.info('Starting Microsoft search', { 
    query,
    accountCount: msCfg.accounts.length 
  });

  const results = [];
  const accountStats = [];
  
  for (const account of msCfg.accounts) {
    const accountLabel = `Microsoft account '${account.alias}'`;
    const accountStartTime = Date.now();
    let accountResults = [];
    
    try {
      logger.info(`${accountLabel}: Starting search for "${query}"`);
      
      // Get access token with timing
      const tokenStartTime = Date.now();
      const token = await getAccessToken(account);
      const tokenTime = Date.now() - tokenStartTime;
      
      if (!token) {
        const warning = `${accountLabel}: No valid token available, skipping search`;
        logger.warn(warning);
        accountStats.push({ alias: account.alias, status: 'no_token', time: Date.now() - accountStartTime });
        continue;
      }
      
      logger.debug(`${accountLabel}: Token acquired in ${tokenTime}ms`);

      // Search across all services in parallel with timing
      const searchStartTime = Date.now();
      let oneDriveResults = [];
      let sharePointResults = [];
      let outlookResults = [];
      
      try {
        [oneDriveResults, sharePointResults, outlookResults] = await Promise.all([
          searchOneDrive(token, account.alias, query),
          searchSharePoint(token, account.alias, query),
          searchOutlook(token, account.alias, query)
        ]);
      } catch (searchError) {
        logger.error(`${accountLabel}: Error in parallel search execution`, {
          message: searchError.message,
          stack: searchError.stack
        });
        // Continue with any successful results
      }
      
      const searchTime = Date.now() - searchStartTime;
      
      // Combine and deduplicate results
      const combinedResults = [...oneDriveResults, ...sharePointResults, ...outlookResults];
      const uniqueResults = Array.from(new Map(combinedResults.map(item => [item.id, item])).values());
      
      accountResults = uniqueResults;
      
      logger.info(`${accountLabel}: Search completed in ${searchTime}ms`, {
        oneDrive: oneDriveResults.length,
        sharePoint: sharePointResults.length,
        outlook: outlookResults.length,
        uniqueResults: uniqueResults.length,
        tokenTime: `${tokenTime}ms`,
        searchTime: `${searchTime}ms`
      });
      
      results.push(...uniqueResults);
      accountStats.push({
        alias: account.alias,
        status: 'success',
        results: uniqueResults.length,
        time: Date.now() - accountStartTime
      });

    } catch (error) {
      logger.error(`${accountLabel}: Fatal error during search`, {
        message: error.message,
        stack: error.stack,
        time: Date.now() - accountStartTime
      });
      
      accountStats.push({
        alias: account.alias,
        status: 'error',
        error: error.message,
        time: Date.now() - accountStartTime
      });
    }
  }

  const totalTime = Date.now() - searchStartTime;
  const uniqueResults = Array.from(new Map(results.map(item => [item.id, item])).values());
  
  logger.info('Microsoft search completed', {
    query,
    totalAccounts: msCfg.accounts.length,
    successfulAccounts: accountStats.filter(s => s.status === 'success').length,
    totalResults: uniqueResults.length,
    totalTime: `${totalTime}ms`,
    accountStats: accountStats.map(s => ({
      alias: s.alias,
      status: s.status,
      results: s.results || 0,
      time: `${s.time}ms`,
      error: s.error || undefined
    }))
  });

  return uniqueResults;
}

module.exports = {
  buildAuthUrl,
  handleCallback,
  searchMicrosoftByName,
  getAccessToken
};