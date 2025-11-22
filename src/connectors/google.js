const logger = require('../logger');
const { google } = require('googleapis');
const { getAuthorizedClient } = require('../auth/google');

async function searchDrive(client, alias, name) {
  const drive = google.drive({ version: 'v3', auth: client });
  
  // Build search query parts
  const qParts = ["trashed = false"];
  if (name && name.trim()) {
    const safe = name.replace(/'/g, "\\'");
    // Try different search patterns to be more flexible
    qParts.push(`(name contains '${safe}' or fullText contains '${safe}')`);
  }
  
  const q = qParts.join(' and ');
  logger.debug('Google Drive search query:', { alias, q });
  
  try {
    const resp = await drive.files.list({
      q,
      corpora: 'allDrives',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink, webContentLink, owners(emailAddress,displayName))',
      orderBy: 'modifiedTime desc',
      pageSize: 50,
    });
    
    logger.debug('Google Drive search results:', { 
      alias, 
      query: name, 
      resultCount: resp.data.files?.length || 0,
      fileNames: resp.data.files?.map(f => f.name) || []
    });
    
    const files = resp?.data?.files || [];
  return files.map((f) => ({
    id: `gdrive:${f.id}`,
    title: f.name,
    source: 'google-drive',
    account: alias,
    path: null,
    url: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
    downloadUrl: f.webContentLink || null,
    mimeType: f.mimeType,
    modified: f.modifiedTime ? new Date(f.modifiedTime).getTime() : null,
    size: f.size ? Number(f.size) : null,
    owner: f.owners?.[0]?.emailAddress || null,
  }));
  } catch (error) {
    logger.error('Google Drive search error:', { 
      alias, 
      error: error.message,
      stack: error.stack,
      response: error.response?.data 
    });
    return [];
  }
}

async function searchGmail(client, alias, name) {
  if (!name || !name.trim()) return [];
  const gmail = google.gmail({ version: 'v1', auth: client });
  const query = `filename:${JSON.stringify(name)}`;
  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 25 })
    .catch((e) => { logger.warn('Gmail list failed: %s', e.message); return { data: {} }; });
  const messages = list?.data?.messages || [];
  const results = [];
  for (const m of messages) {
    const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' })
      .catch(() => null);
    if (!full?.data?.payload) continue;
    const parts = (full.data.payload.parts || []).filter(p => (p.filename || '').toLowerCase().includes(name.toLowerCase()));
    for (const p of parts) {
      results.push({
        id: `gmail:${full.data.id}:${p.partId}`,
        title: p.filename || '(attachment)',
        source: 'gmail-attachment',
        account: alias,
        path: null,
        url: `https://mail.google.com/mail/u/0/#inbox/${full.data.id}`,
        modified: full.data.internalDate ? Number(full.data.internalDate) : null,
        size: p.body?.size || null,
        owner: null,
      });
    }
  }
  return results;
}

async function searchGoogleByName(name, googleCfg) {
  if (!googleCfg?.enabled || !Array.isArray(googleCfg.accounts) || googleCfg.accounts.length === 0) {
    logger.debug('Google provider disabled or no accounts configured');
    return [];
  }
  const out = [];
  for (const acc of googleCfg.accounts) {
    try {
      const client = await getAuthorizedClient({ providers: { google: { accounts: googleCfg.accounts } } }, acc.alias);
      if (!client) { logger.info('Google account %s not connected yet', acc.alias); continue; }
      const [drive, gmail] = await Promise.all([
        searchDrive(client, acc.alias, name),
        searchGmail(client, acc.alias, name),
      ]);
      out.push(...drive, ...gmail);
    } catch (e) {
      logger.warn('Google search failed for %s: %s', acc.alias, e.message);
    }
  }
  return out;
}

module.exports = { searchGoogleByName };
