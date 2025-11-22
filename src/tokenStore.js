const keytar = require('keytar');
const logger = require('./logger');
const SERVICE = 'Docfinder';

function key(provider, alias) {
  return `${provider}:${alias}`;
}

async function saveTokens(provider, alias, tokens) {
  try {
    const keyName = key(provider, alias);
    const tokenData = { ...tokens, updatedAt: new Date().toISOString() };
    await keytar.setPassword(SERVICE, keyName, JSON.stringify(tokenData));
    logger.debug('Saved tokens for %s:%s', provider, alias);
    return true;
  } catch (error) {
    logger.error('Error saving tokens for %s:%s - %s', provider, alias, error.message);
    throw error;
  }
}

async function getTokens(provider, alias) {
  try {
    const keyName = key(provider, alias);
    const raw = await keytar.getPassword(SERVICE, keyName);
    if (!raw) {
      logger.debug('No tokens found for %s:%s', provider, alias);
      return null;
    }
    const parsed = JSON.parse(raw);
    logger.debug('Retrieved tokens for %s:%s', provider, alias);
    return parsed;
  } catch (error) {
    logger.error('Error getting tokens for %s:%s - %s', provider, alias, error.message);
    return null;
  }
}

async function deleteTokens(provider, alias) {
  try {
    const keyName = key(provider, alias);
    const deleted = await keytar.deletePassword(SERVICE, keyName);
    if (deleted) {
      logger.info('Successfully deleted tokens for %s:%s', provider, alias);
    } else {
      logger.warn('No tokens found to delete for %s:%s', provider, alias);
    }
    return deleted;
  } catch (error) {
    logger.error('Error deleting tokens for %s:%s - %s', provider, alias, error.message);
    throw error;
  }
}

module.exports = { saveTokens, getTokens, deleteTokens };
