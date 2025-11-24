const logger = require('../logger');
const { getAuthorizedClient, getAccountConfig } = require('../auth/microsoft');

async function searchOneDrive(client, alias, query) {
  try {
    const driveItems = await client
      .api('/me/drive/root/search(q=\'' + encodeURIComponent(query) + '\')')
      .select('id,name,webUrl,lastModifiedDateTime,size,createdBy,file')
      .top(50)
      .get();

    return (driveItems.value || []).map(item => ({
      id: `onedrive:${item.id}`,
      title: item.name,
      source: 'onedrive',
      account: alias,
      url: item.webUrl,
      modified: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime).getTime() : null,
      size: item.size || 0,
      mimeType: item.file?.mimeType || 'application/octet-stream'
    }));
  } catch (error) {
    logger.error('OneDrive search failed:', { 
      alias, 
      error: error.message,
      stack: error.stack
    });
    return [];
  }
}

async function searchOutlook(client, alias, query) {
  try {
    const messages = await client
      .api('/me/messages')
      .filter(`contains(subject, '${query}') or contains(body/content, '${query}')`)
      .select('id,subject,webLink,receivedDateTime,from,hasAttachments')
      .top(50)
      .get();

    return (messages.value || []).map(message => ({
      id: `outlook:${message.id}`,
      title: message.subject || '(No subject)',
      source: 'outlook',
      account: alias,
      url: message.webLink,
      modified: message.receivedDateTime ? new Date(message.receivedDateTime).getTime() : null,
      from: message.from?.emailAddress?.address
    }));
  } catch (error) {
    logger.error('Outlook search failed:', { 
      alias, 
      error: error.message,
      stack: error.stack
    });
    return [];
  }
}

// In connectors/microsoft.js
async function searchMicrosoftByName(name, msCfg) {
  if (!msCfg?.enabled || !Array.isArray(msCfg.accounts) || msCfg.accounts.length === 0) {
    logger.debug('Microsoft provider disabled or no accounts configured');
    return [];
  }

  const results = [];
  
  for (const account of msCfg.accounts) {
    try {
      logger.info(`Searching Microsoft account: ${account.alias}`);
      
      const client = await getAuthorizedClient({
        alias: account.alias,
        config: { providers: { microsoft: { accounts: msCfg.accounts } } }
      });

      if (!client) {
        logger.warn(`Skipping Microsoft account ${account.alias} - not authenticated`);
        // Add a message about how to reauthenticate
        logger.info(`To authenticate, visit: /auth/microsoft?alias=${encodeURIComponent(account.alias)}`);
        continue;
      }

      const [oneDriveResults, outlookResults] = await Promise.all([
        searchOneDrive(client, account.alias, name),
        searchOutlook(client, account.alias, name)
      ]);

      results.push(...oneDriveResults, ...outlookResults);
      
    } catch (error) {
      logger.error(`Error searching Microsoft account ${account.alias}:`, {
        error: error.message,
        stack: error.stack
      });
    }
  }

  return results;
}

module.exports = { searchMicrosoftByName };