const { Client } = require('@microsoft/microsoft-graph-client');
const { getTokens, saveTokens } = require('../tokenStore');
const logger = require('../logger');

function getAccountConfig(config, alias) {
  const accounts = config?.providers?.microsoft?.accounts || [];
  return accounts.find(a => a.alias === alias);
}

// Merge account-specific config with global OAuth config
function getMergedAccountConfig(config, account) {
  if (!account) {
    return null;
  }
  
  const globalAuth = config?.auth?.microsoft || {};
  
  // Default scopes for Microsoft OAuth
  const defaultScopes = ['Files.Read.All', 'Mail.Read', 'User.Read', 'offline_access'];
  
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
  return {
    alias: account.alias,
    clientId: account.clientId || globalAuth.clientId,
    clientSecret: account.clientSecret || globalAuth.clientSecret,
    tenantId: account.tenantId || globalAuth.tenantId || 'common',
    redirectUri: account.redirectUri || globalAuth.redirectUri,
    scopes: scopes
  };
}

function buildAuthUrl(config, alias) {
  const account = getAccountConfig(config, alias);
  if (!account) {
    throw new Error(`Microsoft account not found: ${alias}`);
  }

  // Merge account config with global OAuth config
  const mergedConfig = getMergedAccountConfig(config, account);
  if (!mergedConfig) {
    throw new Error(`Failed to merge account configuration for: ${alias}`);
  }

  const { clientId, tenantId, redirectUri, scopes } = mergedConfig;
  
  // Ensure scopes is an array and not empty
  let scopeArray = scopes;
  if (!Array.isArray(scopeArray) || scopeArray.length === 0) {
    logger.warn('No scopes provided, using defaults', { alias });
    scopeArray = ['Files.Read.All', 'Mail.Read', 'User.Read', 'offline_access'];
  }
  
  const scopeString = scopeArray.join(' ');
  
  logger.debug('Building Microsoft auth URL', {
    alias,
    scopeCount: scopeArray.length,
    scopes: scopeArray
  });
  
  const state = JSON.stringify({ 
    provider: 'microsoft', 
    alias,
    timestamp: Date.now()
  });

  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('response_type', 'code');
  params.append('redirect_uri', redirectUri);
  params.append('scope', scopeString);  // Space-separated, not URL-encoded
  params.append('state', state);
  params.append('prompt', 'select_account');

  return `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function handleCallback(config, code, state) {
  try {
    logger.debug('=== Starting OAuth Callback ===');
    logger.debug('OAuth callback state', { state, hasCode: !!code });

    const stateObj = state ? JSON.parse(decodeURIComponent(state)) : {};
    const { alias } = stateObj;

    logger.debug('Alias from state', { alias });

    if (!alias) {
      throw new Error('Missing alias in state');
    }

    const account = getAccountConfig(config, alias);
    if (!account) {
      throw new Error(`Microsoft account not found: ${alias}`);
    }

    // Merge account config with global OAuth config
    const mergedConfig = getMergedAccountConfig(config, account);
    if (!mergedConfig) {
      throw new Error(`Failed to merge account configuration for: ${alias}`);
    }

    const { clientId, clientSecret, tenantId, redirectUri, scopes } = mergedConfig;
    const tokenUrl = `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/token`;

    // Ensure scopes is an array and not empty
    let scopeArray = scopes;
    if (!Array.isArray(scopeArray) || scopeArray.length === 0) {
      logger.warn('No scopes provided for token exchange, using defaults', { alias });
      scopeArray = ['Files.Read.All', 'Mail.Read', 'User.Read', 'offline_access'];
    }
    const scopeString = scopeArray.join(' ');

    logger.debug('Token exchange request', {
      tokenUrl,
      redirectUri,
      clientId: clientId ? '***' + clientId.slice(-4) : 'MISSING',
      clientSecret: clientSecret ? '***' + clientSecret.slice(-4) : 'MISSING',
      scopes: scopeString
    });

    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('code', code);
    params.append('redirect_uri', redirectUri);
    params.append('grant_type', 'authorization_code');
    params.append('scope', scopeString);  // Microsoft requires scope in token exchange too

    logger.debug('Sending token request');
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: params.toString()
    });

    const responseText = await response.text();
    logger.debug('Token response', {
      status: response.status,
      headers: Object.fromEntries([...response.headers.entries()]),
      body: responseText
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed with status ${response.status}: ${responseText}`);
    }

    const tokens = JSON.parse(responseText);
    logger.debug('Parsed tokens', {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
      tokenType: tokens.token_type
    });

    if (!tokens.access_token) {
      throw new Error('No access token in response');
    }

    const expiresAt = Date.now() + (tokens.expires_in * 1000);
    const tokenData = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      token_type: tokens.token_type,
      scope: tokens.scope,
      updated_at: new Date().toISOString()
    };

    logger.debug('Saving tokens', { alias });
    await saveTokens('microsoft', alias, tokenData);
    logger.info('OAuth callback completed successfully', { alias });

    return { success: true };

  } catch (error) {
    logger.error('OAuth callback failed', {
      error: error.message,
      stack: error.stack,
      responseStatus: error.response?.status,
      responseData: error.response?.data
    });
    return { 
      success: false, 
      error: error.message,
      stack: error.stack
    };
  }
}

async function getAuthorizedClient(account) {
  try {
    const { alias, config } = account;
    const tokens = await getTokens('microsoft', alias);
    
    if (!tokens?.access_token) {
      logger.warn('No valid tokens found for Microsoft account', { alias });
      return null;
    }

    // Check if token is expired
    const now = Math.floor(Date.now() / 1000); // Convert to seconds
    const tokenExp = tokens.expires_at ? Math.floor(tokens.expires_at / 1000) : 0;
    
    if (tokenExp < now) {
      if (!tokens.refresh_token) {
        logger.warn('Token expired and no refresh token available', { alias });
        return null;
      }
      // Refresh the token
      const newTokens = await refreshAccessToken(account, tokens);
      if (!newTokens?.access_token) {
        logger.error('Failed to refresh access token', { alias });
        return null;
      }
      // Update tokens with the refreshed ones
      Object.assign(tokens, newTokens);
    }

    // In getAuthorizedClient function, replace the token validation with:
    if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
      logger.error('Invalid access token', { 
        alias,
        tokenType: typeof tokens.access_token,
        tokenLength: tokens.access_token?.length
      });
      return null;
    }

    // For debugging, log the first few characters of the token
    logger.debug('Access token format check', {
      alias,
      tokenPrefix: tokens.access_token?.substring(0, 10) + '...',
      hasDot: tokens.access_token?.includes('.')
    });

    // Create and return the authenticated client
    return Client.init({
      authProvider: (done) => {
        done(null, tokens.access_token);
      }
    });

  } catch (error) {
    logger.error('Error getting authorized Microsoft client', {
      alias: account?.alias,
      error: error.message,
      stack: error.stack
    });
    return null;
  }
}

async function refreshAccessToken(account, tokens) {
  try {
    const { alias, config } = account;
    const accountConfig = getAccountConfig(config, alias);
    if (!accountConfig) {
      throw new Error(`Microsoft account not found: ${alias}`);
    }

    // Merge account config with global OAuth config
    const mergedConfig = getMergedAccountConfig(config, accountConfig);
    if (!mergedConfig) {
      throw new Error(`Failed to merge account configuration for: ${alias}`);
    }

    const { clientId, clientSecret, tenantId } = mergedConfig;
    const tokenUrl = `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/token`;

    logger.debug(`Refreshing token for ${alias}`, { 
      hasRefreshToken: !!tokens.refresh_token,
      tokenUrl
    });

    // Get scopes from merged config or use defaults
    let scopeArray = mergedConfig.scopes || ['Files.Read.All', 'Mail.Read', 'User.Read', 'offline_access'];
    if (!Array.isArray(scopeArray)) {
      if (typeof scopeArray === 'string') {
        scopeArray = scopeArray.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        scopeArray = ['Files.Read.All', 'Mail.Read', 'User.Read', 'offline_access'];
      }
    }
    if (scopeArray.length === 0) {
      scopeArray = ['Files.Read.All', 'Mail.Read', 'User.Read', 'offline_access'];
    }
    const scopeString = scopeArray.join(' ');

    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('refresh_token', tokens.refresh_token);
    params.append('grant_type', 'refresh_token');
    params.append('scope', scopeString);

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Failed to refresh token', {
        status: response.status,
        statusText: response.statusText,
        error: errorText
      });
      throw new Error(`Failed to refresh token: ${response.status} ${response.statusText}`);
    }

    const newTokens = await response.json();
    const expiresAt = Date.now() + (newTokens.expires_in * 1000);

    const tokenData = {
      access_token: newTokens.access_token,
      refresh_token: newTokens.refresh_token || tokens.refresh_token, // Keep the old refresh token if not provided
      expires_at: expiresAt,
      token_type: newTokens.token_type,
      scope: newTokens.scope,
      updated_at: new Date().toISOString()
    };

    // Verify the new access token
    if (!tokenData.access_token || typeof tokenData.access_token !== 'string' || !tokenData.access_token.includes('.')) {
      throw new Error('Invalid access token received from refresh');
    }

    await saveTokens('microsoft', alias, tokenData);
    logger.info('Successfully refreshed access token', { alias });
    return tokenData;

  } catch (error) {
    logger.error('Error refreshing Microsoft token:', {
      alias: account?.alias,
      error: error.message,
      stack: error.stack
    });
    return null;
  }
}

// In auth/microsoft.js
async function clearInvalidTokens() {
  try {
    const accounts = ['hotmail', 'retelzy', 'igt']; // Add your account aliases here
    for (const alias of accounts) {
      logger.info(`Clearing tokens for ${alias}...`);
      await deleteTokens('microsoft', alias);
    }
    logger.info('All Microsoft tokens cleared successfully');
  } catch (error) {
    logger.error('Error clearing tokens:', error);
  }
}

module.exports = {
  buildAuthUrl,
  handleCallback,
  getAccountConfig,
  getAuthorizedClient,
  refreshAccessToken,
  clearInvalidTokens
};

// Add this at the bottom of auth/microsoft.js and run it once
if (require.main === module) {
  (async () => {
    const { deleteTokens } = require('../tokenStore');
    const accounts = ['hotmail', 'retelzy', 'igt'];
    for (const alias of accounts) {
      logger.debug(`Deleting tokens for ${alias}`);
      await deleteTokens('microsoft', alias);
    }
    logger.info('Token deletion completed');
  })().catch(error => {
    logger.error('Error in token deletion script', { error: error.message, stack: error.stack });
  });
}