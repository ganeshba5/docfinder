const { OAuth2Client } = require('google-auth-library');
const logger = require('../logger');
const tokenStore = require('../tokenStore');

function getAccount(cfg, alias) {
  const accounts = cfg?.providers?.google?.accounts || [];
  return accounts.find((a) => a.alias === alias);
}

function makeClient(account) {
  if (!account || !account.clientId || !account.clientSecret) {
    throw new Error('Invalid Google account configuration');
  }
  
  return new OAuth2Client(
    account.clientId,
    account.clientSecret,
    account.redirectUri
  );
}

function buildAuthUrl(cfg, alias) {
  try {
    const account = getAccount(cfg, alias);
    if (!account) {
      throw new Error(`Google account not found: ${alias}`);
    }

    const client = makeClient(account);
    const scopes = account.scopes || [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
    ];

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

    // Get the OAuth2 client
    const oauth2Client = makeClient(account);

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

    const client = makeClient(account);
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