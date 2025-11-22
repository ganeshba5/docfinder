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
    const savedTokens = await getTokens('microsoft', account.alias);
    
    if (savedTokens?.accessToken) {
      // Check if token is still valid (with 5 minute buffer)
      if (savedTokens.expiresAt && (savedTokens.expiresAt - 300000) > Date.now()) {
        logger.debug(`${accountLabel}: Using valid saved access token`);
        return savedTokens.accessToken;
      }
      
      // Try to refresh if we have a refresh token
      if (savedTokens.refreshToken) {
        try {
          logger.debug(`${accountLabel}: Token expired, attempting to refresh...`);
          const app = makeApp(account);
          const response = await app.acquireTokenByRefreshToken({
            refreshToken: savedTokens.refreshToken,
            scopes: savedTokens.scopes || ['Files.Read.All', 'Sites.Read.All', 'Mail.Read']
          });

          if (response?.accessToken) {
            // Save the new tokens
            await saveTokens('microsoft', account.alias, {
              accessToken: response.accessToken,
              refreshToken: response.refreshToken || savedTokens.refreshToken,
              expiresAt: response.expiresOn?.getTime(),
              scopes: response.scopes || savedTokens.scopes
            });
            logger.info(`${accountLabel}: Successfully refreshed access token`);
            return response.accessToken;
          }
        } catch (refreshError) {
          logger.warn(`${accountLabel}: Failed to refresh token:`, refreshError.message);
          // Continue to return null to trigger re-authentication
        }
      }
    }
    
    logger.warn(`${accountLabel}: No valid access token available, re-authentication required`);
    return null;

  } catch (error) {
    logger.error(`${accountLabel}: Error getting access token:`, error.message, {
      stack: error.stack
    });
    return null;
  }
}

async function searchOneDrive(token, alias, query) {
  try {
    const endpoint = `https://graph.microsoft.com/v1.0/me/drive/root/search(q='${encodeURIComponent(query || '')}')?$top=50`;
    logger.debug(`Searching OneDrive: ${endpoint}`);
    
    const response = await fetch(endpoint, {
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OneDrive search failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    return (data.value || []).map(item => ({
      id: `onedrive:${item.id}`,
      title: item.name,
      url: item.webUrl,
      type: 'file',
      source: 'microsoft-onedrive',
      account: alias,
      lastModified: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime).getTime() : null,
      size: item.size || null
    }));

  } catch (error) {
    logger.error('Error searching OneDrive:', error.message, {
      stack: error.stack
    });
    return [];
  }
}

async function searchSharePoint(token, alias, query) {
  if (!query?.trim()) return [];
  
  try {
    const endpoint = 'https://graph.microsoft.com/v1.0/search/query';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: [{
          entityTypes: ['driveItem'],
          query: { queryString: query },
          from: 0,
          size: 50
        }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SharePoint search failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    const hits = data.value?.[0]?.hitsContainers?.[0]?.hits || [];
    
    return hits.map(hit => {
      const item = hit.resource || {};
      return {
        id: `sharepoint:${item.id || hit.hitId}`,
        title: item.name || item.title || 'SharePoint Item',
        url: item.webUrl,
        type: 'file',
        source: 'microsoft-sharepoint',
        account: alias,
        lastModified: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime).getTime() : null,
        size: item.size || null
      };
    });

  } catch (error) {
    logger.error('Error searching SharePoint:', error.message, {
      stack: error.stack
    });
    return [];
  }
}

async function searchOutlook(token, alias, query) {
  if (!query?.trim()) return [];
  
  try {
    // First search for relevant messages
    const messagesResponse = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages?$search="attachment:${encodeURIComponent(query)}"&$top=10`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!messagesResponse.ok) {
      const errorText = await messagesResponse.text();
      throw new Error(`Outlook search failed: ${messagesResponse.status} ${messagesResponse.statusText} - ${errorText}`);
    }

    const messagesData = await messagesResponse.json();
    const results = [];

    // Get attachments for each message
    for (const message of messagesData.value || []) {
      const attachmentsResponse = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${message.id}/attachments?$filter=contains(tolower(name),'${query.toLowerCase()}')`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (attachmentsResponse.ok) {
        const attachmentsData = await attachmentsResponse.json();
        for (const attachment of attachmentsData.value || []) {
          results.push({
            id: `outlook:${message.id}:${attachment.id}`,
            title: attachment.name || 'Attachment',
            url: `https://outlook.office.com/mail/id/${message.id}`,
            type: 'file',
            source: 'microsoft-outlook',
            account: alias,
            lastModified: message.receivedDateTime ? new Date(message.receivedDateTime).getTime() : null,
            size: attachment.size || null
          });
        }
      }
    }

    return results;

  } catch (error) {
    logger.error('Error searching Outlook:', error.message, {
      stack: error.stack
    });
    return [];
  }
}

async function searchMicrosoftByName(name, msCfg) {
  if (!msCfg?.enabled) {
    logger.warn('Microsoft provider is disabled in config');
    return [];
  }

  if (!Array.isArray(msCfg.accounts) || !msCfg.accounts.length) {
    logger.warn('No Microsoft accounts configured');
    return [];
  }

  const results = [];
  
  for (const account of msCfg.accounts) {
    const accountLabel = `Microsoft account '${account.alias}'`;
    logger.info(`${accountLabel}: Starting search for "${name}"`);
    
    try {
      // Get access token
      const token = await getAccessToken(account);
      if (!token) {
        logger.warn(`${accountLabel}: No valid token available, skipping search`);
        continue;
      }

      // Search across all services in parallel
      const [oneDriveResults, sharePointResults, outlookResults] = await Promise.all([
        searchOneDrive(token, account.alias, name),
        searchSharePoint(token, account.alias, name),
        searchOutlook(token, account.alias, name)
      ]);

      logger.info(`${accountLabel}: Search completed`, {
        oneDrive: oneDriveResults.length,
        sharePoint: sharePointResults.length,
        outlook: outlookResults.length
      });

      results.push(...oneDriveResults, ...sharePointResults, ...outlookResults);

    } catch (error) {
      logger.error(`${accountLabel}: Error during search:`, error.message, {
        stack: error.stack
      });
    }
  }

  logger.info('Microsoft search completed', {
    query: name,
    resultCount: results.length
  });

  return results;
}

module.exports = {
  buildAuthUrl,
  handleCallback,
  searchMicrosoftByName,
  getAccessToken
};