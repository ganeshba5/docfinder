const msal = require('@azure/msal-node');
const logger = require('../logger');
const { getTokens, saveTokens } = require('../tokenStore');

function getAccount(cfg, alias) {
  const accounts = cfg?.providers?.microsoft?.accounts || [];
  return accounts.find((a) => a.alias === alias);
}

function makeApp(account) {
  if (!account.clientSecret) {
    throw new Error('Microsoft account missing clientSecret. Create a client secret in Entra and add it to this account.');
  }
  const config = {
    auth: {
      clientId: account.clientId,
      authority: `https://login.microsoftonline.com/${account.tenantId || 'common'}`,
      clientSecret: account.clientSecret,
    },
    system: { loggerOptions: { loggerCallback() {}, piiLoggingEnabled: false } },
  };
  const cca = new msal.ConfidentialClientApplication(config);
  return cca;
}

async function loadCache(app, provider, alias) {
  const cached = await getTokens(provider, alias);
  if (cached?.cache) {
    try { app.getTokenCache().deserialize(cached.cache); } catch {}
  }
}

async function saveCache(app, provider, alias) {
  const cache = app.getTokenCache().serialize();
  await saveTokens(provider, alias, { cache });
}

async function buildAuthUrl(cfg, alias) {
  const account = getAccount(cfg, alias);
  if (!account) throw new Error(`Microsoft account not found: ${alias}`);
  const cca = makeApp(account);
  await loadCache(cca, 'microsoft', alias);
  const scopes = account.scopes && account.scopes.length ? account.scopes : [
    'Files.Read.All', 'Sites.Read.All', 'Mail.Read'
  ];
  const authCodeUrlParameters = {
    scopes,
    redirectUri: account.redirectUri,
    state: JSON.stringify({ provider: 'microsoft', alias }),
    prompt: 'select_account',
  };
  const url = await cca.getAuthCodeUrl(authCodeUrlParameters);
  return url;
}

async function handleCallback(cfg, code, stateStr) {
  try {
    logger.info('Starting Microsoft OAuth callback', { state: stateStr });
    const state = JSON.parse(stateStr || '{}');
    const alias = state.alias;
    
    if (!alias) {
      throw new Error('Missing alias in OAuth state');
    }

    const account = getAccount(cfg, alias);
    if (!account) {
      throw new Error(`No Microsoft account found with alias: ${alias}`);
    }

    logger.info('Found Microsoft account for alias', { alias, clientId: account.clientId });
    
    const cca = makeApp(account);
    await loadCache(cca, 'microsoft', alias);
    
    const scopes = account.scopes && account.scopes.length ? account.scopes : [
      'Files.Read.All', 'Sites.Read.All', 'Mail.Read'
    ];
    
    logger.info('Acquiring token with scopes:', { scopes });
    
    const tokenResponse = await cca.acquireTokenByCode({
      code,
      scopes,
      redirectUri: account.redirectUri,
    }).catch(error => {
      logger.error('Error acquiring token:', { error: error.message, stack: error.stack });
      throw new Error(`Failed to acquire token: ${error.message}`);
    });

    if (!tokenResponse) {
      throw new Error('No token response from Microsoft');
    }

    logger.info('Successfully acquired tokens', { 
      hasAccessToken: !!tokenResponse.accessToken,
      hasRefreshToken: !!tokenResponse.refreshToken,
      expiresOn: tokenResponse.expiresOn?.toISOString(),
      account: tokenResponse.account ? {
        username: tokenResponse.account.username,
        localAccountId: tokenResponse.account.localAccountId
      } : null
    });

    // Save the token cache first
    await saveCache(cca, 'microsoft', alias);
    
    // Explicitly save the tokens as well for compatibility
    if (tokenResponse.accessToken) {
      await saveTokens('microsoft', alias, {
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken,
        expiresAt: tokenResponse.expiresOn?.getTime(),
        account: tokenResponse.account,
        scopes: tokenResponse.scopes || scopes
      });
      logger.info('Saved Microsoft tokens for %s', alias);
    } else {
      logger.warn('No access token in Microsoft token response for %s', alias);
    }

    return { alias, success: true };
  } catch (error) {
    logger.error('Error in Microsoft OAuth callback', { 
      error: error.message, 
      stack: error.stack,
      state: stateStr
    });
    throw error;
  }
}

module.exports = { buildAuthUrl, handleCallback };
