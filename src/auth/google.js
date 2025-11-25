const { OAuth2Client } = require('google-auth-library');
const logger = require('../logger');
const tokenStore = require('../tokenStore');

function getAccount(cfg, alias) {
  const accounts = cfg?.providers?.google?.accounts || [];
  return accounts.find((a) => a.alias === alias);
}

// Merge account-specific config with global OAuth config
function getMergedAccountConfig(cfg, account) {
  if (!account) {
    return null;
  }
  
  const globalAuth = cfg?.auth?.google || {};
  
  // Debug logging
  logger.debug('Merging Google account config', {
    alias: account.alias,
    hasAccountClientId: !!account.clientId,
    hasAccountClientSecret: !!account.clientSecret,
    hasGlobalClientId: !!globalAuth.clientId,
    hasGlobalClientSecret: !!globalAuth.clientSecret,
    hasGlobalRedirectUri: !!globalAuth.redirectUri
  });
  
  // Default scopes for Google OAuth
  const defaultScopes = [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/gmail.readonly',
  ];
  
  // Get scopes from account, global config, or use defaults
  let scopes = account.scopes || globalAuth.scopes || defaultScopes;
  
  // Ensure scopes is an array
  if (!Array.isArray(scopes)) {
    if (typeof scopes === 'string') {
      scopes = scopes.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      scopes = defaultScopes;
    }
  }
  
  // If scopes array is empty, use defaults
  if (scopes.length === 0) {
    scopes = defaultScopes;
  }
  
  // Merge: account-specific settings override global settings
  const merged = {
    alias: account.alias,
    clientId: account.clientId || globalAuth.clientId,
    clientSecret: account.clientSecret || globalAuth.clientSecret,
    redirectUri: account.redirectUri || globalAuth.redirectUri,
    scopes: scopes
  };
  
  // Validate merged config
  if (!merged.clientId || !merged.clientSecret || !merged.redirectUri) {
    logger.error('Invalid merged Google account config', {
      alias: account.alias,
      hasClientId: !!merged.clientId,
      hasClientSecret: !!merged.clientSecret,
      hasRedirectUri: !!merged.redirectUri,
      globalAuthKeys: Object.keys(globalAuth),
      accountKeys: Object.keys(account)
    });
  }
  
  return merged;
}

function makeClient(accountConfig) {
  if (!accountConfig || !accountConfig.clientId || !accountConfig.clientSecret) {
    throw new Error('Invalid Google account configuration: missing clientId or clientSecret');
  }
  
  if (!accountConfig.redirectUri) {
    throw new Error('Invalid Google account configuration: missing redirectUri');
  }
  
  return new OAuth2Client(
    accountConfig.clientId,
    accountConfig.clientSecret,
    accountConfig.redirectUri
  );
}

function buildAuthUrl(cfg, alias) {
  try {
    logger.debug('Building Google auth URL', {
      alias,
      hasConfig: !!cfg,
      hasAuthGoogle: !!cfg?.auth?.google,
      globalClientId: !!cfg?.auth?.google?.clientId,
      globalClientSecret: !!cfg?.auth?.google?.clientSecret,
      globalRedirectUri: !!cfg?.auth?.google?.redirectUri,
      accountsCount: cfg?.providers?.google?.accounts?.length || 0
    });

    const account = getAccount(cfg, alias);
    if (!account) {
      logger.error('Google account not found', { alias, availableAccounts: cfg?.providers?.google?.accounts?.map(a => a.alias) || [] });
      throw new Error(`Google account not found: ${alias}`);
    }

    logger.debug('Found Google account', { alias, accountKeys: Object.keys(account) });

    // Merge account config with global OAuth config
    const mergedConfig = getMergedAccountConfig(cfg, account);
    if (!mergedConfig) {
      throw new Error(`Failed to merge account configuration for: ${alias}`);
    }

    logger.debug('Merged config', {
      alias,
      hasClientId: !!mergedConfig.clientId,
      hasClientSecret: !!mergedConfig.clientSecret,
      hasRedirectUri: !!mergedConfig.redirectUri,
      scopesCount: mergedConfig.scopes?.length || 0
    });

    const client = makeClient(mergedConfig);
    let scopes = mergedConfig.scopes;

    // Ensure scopes is an array and not empty
    if (!Array.isArray(scopes) || scopes.length === 0) {
      logger.warn('No scopes provided, using defaults', { alias });
      scopes = [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/gmail.readonly',
      ];
    }

    logger.debug('Generating Google auth URL with scopes', { 
      alias, 
      scopeCount: scopes.length,
      scopes: scopes 
    });

    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
      state: JSON.stringify({ provider: 'google', alias }),
    });
  } catch (error) {
    logger.error('Error building Google auth URL:', error);
    throw error;
  }
}

async function handleCallback(config, code, state) {
  try {
    // Parse state to get provider and alias
    const stateData = JSON.parse(state);
    const { alias } = stateData;
    
    if (!alias) {
      throw new Error('Missing alias in OAuth state');
    }

    // Get the account configuration
    const account = getAccount(config, alias);
    if (!account) {
      throw new Error(`No Google account found with alias: ${alias}`);
    }

    logger.info('Processing Google OAuth callback', { alias });

    // Merge account config with global OAuth config
    const mergedConfig = getMergedAccountConfig(config, account);
    if (!mergedConfig) {
      throw new Error(`Failed to merge account configuration for: ${alias}`);
    }

    // Get the OAuth2 client
    const oauth2Client = makeClient(mergedConfig);

    // Exchange the authorization code for tokens
    const { tokens } = await oauth2Client.getToken(code).catch(error => {
      logger.error('Error exchanging code for tokens:', error);
      throw new Error(`Failed to exchange code for tokens: ${error.message}`);
    });

    if (!tokens || !tokens.access_token) {
      throw new Error('No access token received from Google');
    }

    logger.info('Google OAuth tokens received', {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null
    });
    
    // Save the tokens
    await tokenStore.saveTokens('google', alias, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date
    });

    // Verify the tokens were saved
    const savedTokens = await tokenStore.getTokens('google', alias);
    if (!savedTokens || !savedTokens.access_token) {
      throw new Error('Failed to verify token storage');
    }

    logger.info('Google OAuth completed successfully', { alias });
    return { success: true, alias };

  } catch (error) {
    logger.error('Error in Google OAuth callback', { 
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

async function getAuthorizedClient(cfg, alias) {
  try {
    if (!alias) {
      throw new Error('Missing required parameter: alias');
    }

    logger.info('Getting authorized client for Google account', { alias });
    
    const account = getAccount(cfg, alias);
    if (!account) {
      throw new Error(`Google account not found: ${alias}`);
    }

    const tokens = await tokenStore.getTokens('google', alias);
    if (!tokens || !tokens.access_token) {
      logger.warn('No valid tokens found for Google account', { alias });
      return null;
    }

    // Merge account config with global OAuth config
    const mergedConfig = getMergedAccountConfig(cfg, account);
    if (!mergedConfig) {
      throw new Error(`Failed to merge account configuration for: ${alias}`);
    }

    const client = makeClient(mergedConfig);
    client.setCredentials(tokens);

    // Verify the credentials are still valid
    try {
      await client.getAccessToken();
      logger.debug('Successfully refreshed Google access token', { alias });
      return client;
    } catch (error) {
      logger.warn('Failed to refresh Google access token', { 
        alias,
        error: error.message
      });
      return null;
    }
  } catch (error) {
    logger.error('Error getting authorized Google client', {
      alias,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

module.exports = { 
  buildAuthUrl, 
  handleCallback, 
  getAuthorizedClient 
};