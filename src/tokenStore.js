// src/tokenStore.js
const keytar = require('keytar');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const config = require('./config');
const logger = require('./logger');
const SERVICE = 'docfinder';  

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);

const TOKEN_FILE = config.tokenStorage.filePath;

// Ensure the directory exists
const TOKEN_DIR = path.dirname(TOKEN_FILE);
if (!fs.existsSync(TOKEN_DIR)) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
}

function key(provider, alias) {
  return `${provider}:${alias}`;
}

// Helper to log token operations
function logOperation(operation, provider, alias, data = null) {
  const logData = { operation, provider, alias };
  if (data) logData.data = data;
  logger.debug('Token store operation:', logData);
}

// Helper to log errors
function logError(operation, error, provider = null, alias = null) {
  const logData = { operation, error: error.message, stack: error.stack };
  if (provider) logData.provider = provider;
  if (alias) logData.alias = alias;
  logger.error('Token store error:', logData);
}

// File-based token storage
const fileStore = {
  async save(provider, alias, tokens) {
    logOperation('save', provider, alias, { hasToken: !!tokens });
    let data = {};
    try {
      if (fs.existsSync(TOKEN_FILE)) {
        const content = await readFile(TOKEN_FILE, 'utf8');
        if (content) {
          data = JSON.parse(content);
        }
      }
      data[key(provider, alias)] = tokens;
      await writeFile(TOKEN_FILE, JSON.stringify(data, null, 2));
      logOperation('save_success', provider, alias);
    } catch (error) {
      logError('file_save', error, provider, alias);
      throw error;
    }
  },

  async get(provider, alias) {
    logOperation('get', provider, alias);
    try {
      if (!fs.existsSync(TOKEN_FILE)) {
        logOperation('file_not_found', provider, alias);
        return null;
      }
      
      const content = await readFile(TOKEN_FILE, 'utf8');
      if (!content) {
        logOperation('empty_file', provider, alias);
        return null;
      }
      
      const data = JSON.parse(content);
      const result = data[key(provider, alias)] || null;
      logOperation('get_success', provider, alias, { hasToken: !!result });
      return result;
    } catch (error) {
      logError('file_get', error, provider, alias);
      return null;
    }
  },

  async delete(provider, alias) {
    logOperation('delete', provider, alias);
    try {
      if (!fs.existsSync(TOKEN_FILE)) {
        logOperation('file_not_found', provider, alias);
        return;
      }
      
      const content = await readFile(TOKEN_FILE, 'utf8');
      if (!content) {
        logOperation('empty_file', provider, alias);
        return;
      }
      
      const data = JSON.parse(content);
      const keyStr = key(provider, alias);
      if (data.hasOwnProperty(keyStr)) {
        delete data[keyStr];
        await writeFile(TOKEN_FILE, JSON.stringify(data, null, 2));
        logOperation('delete_success', provider, alias);
      }
    } catch (error) {
      logError('file_delete', error, provider, alias);
      throw error;
    }
  }
};

// Keychain-based token storage
const keychainStore = {
  async save(provider, alias, tokens) {
    logOperation('keychain_save', provider, alias);
    try {
      const keyStr = key(provider, alias);
      await keytar.setPassword(SERVICE, keyStr, JSON.stringify(tokens));
      logOperation('keychain_save_success', provider, alias);
    } catch (error) {
      logError('keychain_save', error, provider, alias);
      throw error;
    }
  },

  async get(provider, alias) {
    const keyStr = key(provider, alias);
    logOperation('keychain_get', provider, alias);
    logger.debug(`Looking for key: ${keyStr} in keychain`);
    
    try {
      const result = await keytar.getPassword(SERVICE, keyStr);
      logger.debug(`Keychain lookup result for ${keyStr}: ${result ? 'FOUND' : 'NOT FOUND'}`);
      
      if (!result) {
        logOperation('keychain_not_found', provider, alias);
        return null;
      }
      
      // Parse the result and ensure consistent property names
      const tokenData = JSON.parse(result);
      const normalizedTokens = {
        access_token: tokenData.access_token || tokenData.accessToken,
        refresh_token: tokenData.refresh_token || tokenData.refreshToken,
        expires_at: tokenData.expires_at || tokenData.expiresAt,
        scope: tokenData.scope,
        token_type: tokenData.token_type || tokenData.tokenType,
      };
      
      logOperation('keychain_get_success', provider, alias, {
        hasAccessToken: !!normalizedTokens.access_token,
        hasRefreshToken: !!normalizedTokens.refresh_token,
        expiresAt: normalizedTokens.expires_at ? new Date(normalizedTokens.expires_at).toISOString() : 'none'
      });
      
      return normalizedTokens;
    } catch (error) {
      logger.debug('Error in keychain lookup', { keyStr, error: error.message });
      logError('keychain_get', error, provider, alias);
      return null;
    }
  },

  async delete(provider, alias) {
    logOperation('keychain_delete', provider, alias);
    try {
      const keyStr = key(provider, alias);
      const deleted = await keytar.deletePassword(SERVICE, keyStr);
      logOperation('keychain_delete_success', provider, alias, { deleted });
      return deleted;
    } catch (error) {
      logError('keychain_delete', error, provider, alias);
      throw error;
    }
  }
};

// Use keytar if available, otherwise fall back to file storage
let store;
try {
  // Test if keytar is available
  keytar.getPassword('test', 'test').catch(() => {
    throw new Error('keytar not available');
  });
  store = keychainStore;
  logger.info('Using keychain for token storage');
} catch (error) {
  logger.warn('Keytar not available, falling back to file storage', { error: error.message });
  store = fileStore;
}

// Public API
// In tokenStore.js
async function saveTokens(provider, alias, tokens) {
  try {
    logger.debug('Saving tokens', {
      provider,
      alias,
      tokenData: {
        accessToken: tokens.access_token ? '***' + tokens.access_token.slice(-8) : 'MISSING',
        refreshToken: tokens.refresh_token ? '***' + tokens.refresh_token.slice(-8) : 'MISSING',
        expiresAt: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : 'MISSING',
        tokenType: tokens.token_type || 'MISSING'
      }
    });

    const key = `${provider}:${alias}`;
    const value = JSON.stringify(tokens);
    
    logger.debug('Token storage details', { key, service: SERVICE });
    
    // Make sure we're using the SERVICE constant
    await keytar.setPassword(SERVICE, key, value);
    
    // Verify the tokens were saved
    const saved = await keytar.getPassword(SERVICE, key);
    if (!saved) {
      throw new Error('Failed to verify token storage - tokens not found after saving');
    }
    
    logger.debug('Tokens saved and verified successfully', { provider, alias });
    return true;
  } catch (error) {
    logger.error('Failed to save tokens', {
      error: error.message,
      stack: error.stack,
      provider,
      alias
    });
    throw error;
  }
}

async function getTokens(provider, alias, callback) {
  try {
    logger.debug('Retrieving tokens from store', { provider, alias });
    
    const tokens = await store.get(provider, alias);
    
    if (!tokens) {
      logger.debug('No tokens found in store', { provider, alias });
      if (callback) return callback(null, null);
      return null;
    }

    // Log token details for debugging
    const tokenInfo = {
      provider,
      alias,
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiresAt: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null,
      isExpired: tokens.expires_at ? tokens.expires_at < Date.now() : true,
      lastUpdated: tokens.last_updated || 'unknown'
    };

    logger.debug('Retrieved tokens from store', tokenInfo);

    // If we have tokens but they're malformed, log it
    if (!tokens.access_token && !tokens.refresh_token) {
      const error = new Error('Invalid token data in store - missing both access and refresh tokens');
      logger.error(error.message, {
        provider,
        alias,
        tokenKeys: Object.keys(tokens)
      });
      if (callback) return callback(error);
      return null;
    }

    if (callback) return callback(null, tokens);
    return tokens;
  } catch (error) {
    logger.error('Error retrieving tokens from store:', {
      error: error.message,
      stack: error.stack,
      provider,
      alias
    });
    if (callback) return callback(error);
    return null;
  }
}

async function reinitializeTokens(provider, alias) {
  try {
    logger.info(`Reinitializing tokens for ${provider}:${alias}`);
    
    // Delete existing tokens
    await deleteTokens(provider, alias);
    
    // Return null to trigger re-authentication
    return null;
  } catch (error) {
    logger.error('Error reinitializing tokens:', {
      error: error.message,
      provider,
      alias
    });
    throw error;
  }
}

async function deleteTokens(provider, alias, callback) {
  try {
    const result = await store.delete(provider, alias);
    if (callback) return callback(null, result);
    return result;
  } catch (error) {
    logger.error('Error deleting tokens:', {
      error: error.message,
      provider,
      alias,
      stack: error.stack
    });
    if (callback) return callback(error);
    throw error;
  }
}

async function checkTokenStore() {
  try {
    const accounts = ['hotmail', 'retelzy', 'igt'];
    for (const alias of accounts) {
      const tokens = await getTokens('microsoft', alias);
      logger.debug('Token store check', {
        alias,
        hasTokens: !!tokens,
        hasAccessToken: tokens ? !!tokens.access_token : false,
        hasRefreshToken: tokens ? !!tokens.refresh_token : false,
        expiresAt: tokens && tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null
      });
    }
  } catch (error) {
    logger.error('Error checking token store:', error);
  }
}


module.exports = {
  saveTokens,
  getTokens,
  deleteTokens,
  checkTokenStore,
  reinitializeTokens
};

// Check token store on startup (for debugging)
if (process.env.NODE_ENV !== 'production') {
  checkTokenStore().catch(error => {
    logger.error('Error during token store check:', error);
  });
}