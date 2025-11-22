const { google } = require('googleapis');
const logger = require('../logger');
const { getTokens, saveTokens } = require('../tokenStore');

function getAccount(cfg, alias) {
  const accounts = cfg?.providers?.google?.accounts || [];
  return accounts.find((a) => a.alias === alias);
}

function makeClient(account) {
  const oauth2Client = new google.auth.OAuth2(
    account.clientId,
    account.clientSecret,
    account.redirectUri
  );
  return oauth2Client;
}

function buildAuthUrl(cfg, alias) {
  const account = getAccount(cfg, alias);
  if (!account) throw new Error(`Google account not found: ${alias}`);
  const client = makeClient(account);
  const scopes = account.scopes && account.scopes.length ? account.scopes : [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/gmail.readonly',
  ];
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state: JSON.stringify({ provider: 'google', alias }),
  });
  return url;
}

async function handleCallback(cfg, code, stateStr) {
  try {
    logger.info('Starting Google OAuth callback', { state: stateStr });
    const state = JSON.parse(stateStr || '{}');
    const alias = state.alias;
    
    if (!alias) {
      throw new Error('Missing alias in OAuth state');
    }

    const account = getAccount(cfg, alias);
    if (!account) {
      throw new Error(`No Google account found with alias: ${alias}`);
    }

    logger.info('Found Google account for alias', { alias, clientId: account.clientId });

    const client = makeClient(account);
    const { tokens } = await client.getToken(code).catch(error => {
      logger.error('Error getting tokens', { error: error.message, stack: error.stack });
      throw new Error(`Failed to get tokens: ${error.message}`);
    });

    if (!tokens) {
      throw new Error('No tokens returned from Google');
    }

    logger.info('Saving Google tokens', { alias, hasRefreshToken: !!tokens.refresh_token });
    await saveTokens('google', alias, tokens);
    logger.info('Successfully saved Google tokens', { alias });
    return { alias };

  } catch (error) {
    logger.error('Error in Google OAuth callback', { 
      error: error.message, 
      stack: error.stack,
      state: stateStr
    });
    throw error;
  }
}

async function getAuthorizedClient(cfg, alias) {
  const account = getAccount(cfg, alias);
  if (!account) throw new Error(`Google account not found: ${alias}`);
  const tokens = await getTokens('google', alias);
  if (!tokens) return null;
  const client = makeClient(account);
  client.setCredentials(tokens);
  return client;
}

module.exports = { buildAuthUrl, handleCallback, getAuthorizedClient };
