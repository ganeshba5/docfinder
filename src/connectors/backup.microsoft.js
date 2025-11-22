const logger = require('../logger');
const msal = require('@azure/msal-node');
const { getTokens, saveTokens } = require('../tokenStore');
const util = require('util');

// node-fetch v3 ESM interop
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

function makeApp(account) {
  if (!account.clientSecret) {
    throw new Error('Microsoft account missing clientSecret. Add clientSecret to config.');
  }
  const config = {
    auth: {
      clientId: account.clientId,
      authority: `https://login.microsoftonline.com/${account.tenantId || 'common'}`,
      clientSecret: account.clientSecret,
    },
  };
  return new msal.ConfidentialClientApplication(config);
}

async function loadCache(pca, alias) {
  const cached = await getTokens('microsoft', alias);
  if (cached?.cache) {
    try { pca.getTokenCache().deserialize(cached.cache); } catch {}
  }
}

async function saveCache(pca, alias) {
  const cache = pca.getTokenCache().serialize();
  await saveTokens('microsoft', alias, { cache });
}

async function getAccessToken(account) {
  const accountLabel = `Microsoft account '${account.alias}'`;
  logger.debug(`${accountLabel}: Starting token acquisition`);
  
  try {
    const app = makeApp(account);
    logger.debug(`${accountLabel}: Created MSAL client application`);
    
    // First try to get tokens from the keychain
    const savedTokens = await getTokens('microsoft', account.alias);
    if (savedTokens?.accessToken) {
      logger.debug(`${accountLabel}: Found saved access token`);
      // Check if token is expired
      if (savedTokens.expiresAt && savedTokens.expiresAt > Date.now()) {
        logger.debug(`${accountLabel}: Using valid saved access token`);
        return savedTokens.accessToken;
      } else if (savedTokens.refreshToken) {
        logger.debug(`${accountLabel}: Access token expired, attempting to refresh`);
        try {
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
            logger.debug(`${accountLabel}: Successfully refreshed access token`);
            return response.accessToken;
          }
        } catch (refreshError) {
          logger.warn(`${accountLabel}: Failed to refresh token: ${refreshError.message}`);
          // Continue to try other methods
        }
      }
    }
    
    // If we get here, we need to get a new token interactively
    logger.debug(`${accountLabel}: No valid tokens found, attempting to load from cache`);
    
    // Load the token cache
    await loadCache(app, 'microsoft', account.alias);
    
    // Get accounts from cache
    const accounts = await app.getTokenCache().getAllAccounts();
    logger.debug(`${accountLabel}: Found ${accounts.length} accounts in cache`);
    
    if (accounts.length > 0) {
      const scopes = account.scopes?.length 
        ? account.scopes 
        : ['Files.Read.All', 'Sites.Read.All', 'Mail.Read'];
      
      logger.debug(`${accountLabel}: Attempting silent token acquisition`);
      try {
        const response = await app.acquireTokenSilent({
          account: accounts[0],
          scopes,
          forceRefresh: false
        });
        
        if (response?.accessToken) {
          // Save the tokens for future use
          await saveTokens('microsoft', account.alias, {
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            expiresAt: response.expiresOn?.getTime(),
            scopes: response.scopes || scopes
          });
          
          logger.debug(`${accountLabel}: Successfully acquired new access token silently`);
          return response.accessToken;
        }
      } catch (silentError) {
        logger.warn(`${accountLabel}: Silent token acquisition failed: ${silentError.message}`);
      }
    }
    
    // If we get here, we need to prompt the user to sign in again
    logger.warn(`${accountLabel}: No valid tokens available, user needs to sign in again`);
    return null;
    
  } catch (error) {
    logger.error(`${accountLabel}: Error in getAccessToken: ${error.message}`, {
      stack: error.stack,
      errorDetails: util.inspect(error, { depth: null })
    });
    return null;
  }
}
async function graphGet(token, url) {
  try {
    logger.debug(`Graph API request: ${url}`);
    const startTime = Date.now();
    
    const response = await fetch(url, { 
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Docfinder/1.0'
      },
      timeout: 10000 // 10 second timeout
    });
    
    const responseTime = Date.now() - startTime;
    const responseText = await response.text();
    
    // Log response details
    logger.debug(`Graph API response (${response.status} in ${responseTime}ms):`, {
      url,
      status: response.status,
      statusText: response.statusText,
      responseTime: `${responseTime}ms`,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      responseBody: responseText.length > 500 ? 
        responseText.substring(0, 500) + '... [truncated]' : 
        responseText
    });
    
    if (!response.ok) {
      let errorMessage = `Graph API error: ${response.status} ${response.statusText}`;
      try {
        const errorJson = JSON.parse(responseText);
        errorMessage += ` - ${errorJson.error?.message || responseText}`;
      } catch (e) {
        errorMessage += ` - ${responseText}`;
      }
      throw new Error(errorMessage);
    }
    
    try {
      return responseText ? JSON.parse(responseText) : {};
    } catch (e) {
      logger.error('Failed to parse Graph API response:', e.message, {
        responseText,
        url
      });
      throw new Error('Failed to parse API response');
    }
    
  } catch (error) {
    logger.error('Graph API request failed:', {
      url,
      error: error.message,
      stack: error.stack,
      code: error.code,
      name: error.name
    });
    throw error;
  }
}

async function searchOneDrive(token, alias, name) {
  try {
    const safe = encodeURIComponent(name || '');
    const endpoint = `https://graph.microsoft.com/v1.0/me/drive/root/search(q='${safe}')?$top=50`;
    logger.debug('Searching OneDrive:', { alias, endpoint });
    
    const json = await graphGet(token, endpoint).catch((e) => {
      // Suppress noisy logs for tenants without SharePoint/OneDrive for Business
      if (String(e.message).includes('Tenant does not have a SPO license')) {
        logger.info('Skipping OneDrive search for %s: no SharePoint Online license', alias);
        return { value: [] };
      }
      logger.warn('OneDrive search failed: %s', e.message, { stack: e.stack });
      return { value: [] };
    });
    
    const items = json.value || [];
    logger.debug('OneDrive search results:', { alias, count: items.length });
    
    return items.map((it) => ({
      id: `onedrive:${it.id}`,
      title: it.name,
      source: 'microsoft-onedrive',
      account: alias,
      path: null,
      url: it.webUrl,
      modified: it.lastModifiedDateTime ? new Date(it.lastModifiedDateTime).getTime() : null,
      size: it.size || null,
      owner: null,
    }));
  } catch (e) {
    logger.error('Error in searchOneDrive for %s: %s', alias, e.message, { stack: e.stack });
    return [];
  }
}

async function searchSharePointDriveItems(token, alias, name) {
  if (!name || !name.trim()) return [];
  const body = {
    requests: [
      {
        entityTypes: ["driveItem"],
        query: { queryString: name },
        from: 0,
        size: 50,
      },
    ],
  };
  let json;
  try {
    const r = await fetch('https://graph.microsoft.com/v1.0/search/query', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Graph search ${r.status}: ${t}`);
    }
    json = await r.json();
  } catch (e) {
    const msg = String(e.message || '');
    // Common transient or unsupported scenarios: suppress to avoid log spam
    if (msg.includes('SearchPlatformResolutionFailed')) {
      logger.info('Skipping SharePoint/Teams search (platform resolution failed) for %s', alias);
      return [];
    }
    if (msg.includes('Tenant does not have a SPO license')) {
      logger.info('Skipping SharePoint/Teams search for %s: no SPO license', alias);
      return [];
    }
    logger.warn('SharePoint/Teams search failed: %s', e.message);
    return [];
  }
  const hits = json.value?.[0]?.hitsContainers?.[0]?.hits || [];
  return hits.map((h) => {
    const it = h.resource || {};
    const title = it.name || it.title || 'item';
    const webUrl = it.webUrl || it.webUrlPath || null;
    const modified = it.lastModifiedDateTime || it.lastModifiedTime || null;
    const size = it.size || null;
    // Attempt to categorize source from driveType if present
    const driveType = it.parentReference?.driveType;
    const source = driveType === 'business' ? 'microsoft-sharepoint' : 'microsoft-teams';
    return {
      id: `sp:${it.id || h.hitId}`,
      title,
      source,
      account: alias,
      path: null,
      url: webUrl,
      modified: modified ? new Date(modified).getTime() : null,
      size,
      owner: null,
    };
  });
}

async function searchOutlookAttachments(token, alias, name) {
  if (!name || !name.trim()) return [];
  // Heuristic: get recent messages with attachments, then match attachment names
  const messages = await graphGet(token, `https://graph.microsoft.com/v1.0/me/messages?$filter=hasAttachments eq true&$orderby=receivedDateTime desc&$top=25`).catch(() => ({ value: [] }));
  const out = [];
  const lower = name.toLowerCase();
  for (const m of messages.value || []) {
    const atts = await graphGet(token, `https://graph.microsoft.com/v1.0/me/messages/${m.id}/attachments?$top=20`).catch(() => ({ value: [] }));
    for (const a of atts.value || []) {
      const filename = a.name || a.fileName || '';
      if (filename.toLowerCase().includes(lower)) {
        out.push({
          id: `outlook:${m.id}:${a.id}`,
          title: filename || '(attachment)',
          source: 'microsoft-outlook-attachment',
          account: alias,
          path: null,
          url: `https://outlook.office.com/mail/inbox/id/${m.id}`,
          modified: m.receivedDateTime ? new Date(m.receivedDateTime).getTime() : null,
          size: a.size || null,
          owner: null,
        });
      }
    }
  }
  return out;
}

async function searchMicrosoftByName(name, msCfg) {
  if (!msCfg?.enabled) {
    logger.warn('Microsoft provider is disabled in config');
    return [];
  }
  
  if (!Array.isArray(msCfg.accounts) || msCfg.accounts.length === 0) {
    logger.warn('No Microsoft accounts configured');
    return [];
  }
  
  logger.info('Starting Microsoft search', { 
    query: name, 
    accountCount: msCfg.accounts.length,
    accountAliases: msCfg.accounts.map(a => a.alias).join(', ')
  });
  
  const out = [];
  
  for (const acc of msCfg.accounts) {
    const accountLabel = `Microsoft account '${acc.alias}'`;
    logger.debug(`Processing ${accountLabel}`);
    
    try {
      logger.debug(`${accountLabel}: Getting access token...`);
      const token = await getAccessToken(acc);
      
      if (!token) { 
        logger.warn(`${accountLabel}: No access token available - account may not be connected`);
        // Check if we have tokens in the store
        const tokens = await getTokens('microsoft', acc.alias);
        logger.debug(`${accountLabel}: Token store contents:`, JSON.stringify(tokens, null, 2));
        continue; 
      }
      
      logger.debug(`${accountLabel}: Successfully acquired access token (${token.substring(0, 10)}...)`);
      
      // Test the token with a basic Graph API call
      try {
        logger.debug(`${accountLabel}: Testing token with basic Graph API call...`);
        const me = await graphGet(token, 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName');
        logger.debug(`${accountLabel}: Successfully connected to Graph API as ${me.displayName} (${me.userPrincipalName})`);
      } catch (e) {
        logger.error(`${accountLabel}: Failed to connect to Graph API:`, e.message);
        continue;
      }
      
      logger.debug(`${accountLabel}: Starting parallel searches...`);
      const [files, sp, mails] = await Promise.all([
        searchOneDrive(token, acc.alias, name || ''),
        searchSharePointDriveItems(token, acc.alias, name || ''),
        searchOutlookAttachments(token, acc.alias, name || '')
      ]);
      
      logger.info(`${accountLabel}: Search completed`, { 
        oneDriveResults: files.length,
        sharePointResults: sp.length,
        outlookResults: mails.length,
        totalResults: files.length + sp.length + mails.length
      });
      
      out.push(...files, ...sp, ...mails);
      
    } catch (e) {
      logger.error(`${accountLabel}: Search failed - ${e.message}`, { 
        stack: e.stack,
        errorDetails: util.inspect(e, { depth: null })
      });
    }
  }
  
  logger.info('Microsoft search completed', { 
    query: name,
    totalResults: out.length,
    resultsBySource: {
      oneDrive: out.filter(r => r.source === 'microsoft-onedrive').length,
      sharePoint: out.filter(r => r.source === 'microsoft-sharepoint').length,
      teams: out.filter(r => r.source === 'microsoft-teams').length,
      outlook: out.filter(r => r.source === 'microsoft-outlook-attachment').length
    }
  });
  
  return out;
}

module.exports = { searchMicrosoftByName };
