const express = require('express');
const path = require('path');
const { loadConfig } = require('./config');
const { unifiedSearchByName } = require('./search/unified');
const logger = require('./logger');
const { saveConfig } = require('./configWrite');
const googleAuth = require('./auth/google');
const msAuth = require('./auth/microsoft');
const { getTokens } = require('./tokenStore');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve results.html for the results page
app.get('/results.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'results.html'));
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Search endpoint
app.get('/api/search', async (req, res) => {
  const name = String(req.query.name || '').trim();
  const sourcesFilter = String(req.query.sources || '').split(',').map(s => s.trim()).filter(Boolean);
  const accountsFilter = String(req.query.accounts || '').split(',').map(s => s.trim()).filter(Boolean);
  
  logger.info('Search request:', { 
    name, 
    sourcesFilter, 
    accountsFilter,
    hasName: !!name,
    hasSources: sourcesFilter.length > 0,
    hasAccounts: accountsFilter.length > 0
  });
  
  try {
    const cfg = loadConfig();
    let results = await unifiedSearchByName(name, cfg, {
      includeSources: sourcesFilter,
      includeAccounts: accountsFilter,
    });
    
    logger.info('Search results:', { 
      resultCount: results.length,
      sources: [...new Set(results.map(r => r.source))]
    });
    
    res.json({ results });
  } catch (e) {
    logger.error('Search error: %s', e.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Add or update account
app.post('/api/accounts/update', (req, res) => {
  try {
    const { provider, alias, updates } = req.body || {};
    if (!provider || !alias || !updates) return res.status(400).json({ error: 'Missing required fields' });
    if (!['google', 'microsoft'].includes(provider)) return res.status(400).json({ error: 'Invalid provider' });
    
    const cfg = saveConfig((c) => {
      // Initialize providers object if it doesn't exist
      if (!c.providers) c.providers = {};
      
      // Initialize provider if it doesn't exist
      if (!c.providers[provider]) {
        c.providers[provider] = { enabled: true, accounts: [] };
      }
      
      const prov = c.providers[provider];
      const accounts = prov.accounts || [];
      const idx = accounts.findIndex(a => a.alias === alias);
      
      if (idx === -1) {
        // Add new account
        accounts.push({ ...updates, alias });
      } else {
        // Update existing account
        const current = accounts[idx];
        const next = { ...current };
        const allowed = ['clientId', 'clientSecret', 'tenantId', 'redirectUri', 'scopes'];
        for (const k of allowed) {
          if (k in updates && updates[k] !== undefined) next[k] = updates[k];
        }
        accounts[idx] = next;
      }
      
      prov.accounts = accounts;
      return c;
    });
    
    res.json({ success: true });
  } catch (e) {
    logger.error('Error updating account: %s', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Delete account
app.delete('/api/accounts/:provider/:alias', async (req, res) => {
  try {
    const { provider, alias } = req.params;
    if (!provider || !alias) return res.status(400).json({ error: 'Missing required fields' });
    if (!['google', 'microsoft'].includes(provider)) return res.status(400).json({ error: 'Invalid provider' });
    
    // First delete the tokens from keychain
    try {
      const { deleteTokens } = require('./tokenStore');
      await deleteTokens(provider, alias);
      logger.info('Deleted tokens for %s account %s', provider, alias);
    } catch (tokenError) {
      logger.warn('Error deleting tokens for %s account %s: %s', provider, alias, tokenError.message);
      // Continue with account deletion even if token deletion fails
    }
    
    const cfg = saveConfig((c) => {
      if (!c.providers?.[provider]) {
        throw new Error('Provider not configured');
      }
      
      const accounts = c.providers[provider].accounts || [];
      const idx = accounts.findIndex(a => a.alias === alias);
      
      if (idx === -1) {
        throw new Error('Account not found');
      }
      
      // Remove the account
      accounts.splice(idx, 1);
      c.providers[provider].accounts = accounts;
      
      // Disable provider if no accounts left
      if (accounts.length === 0) {
        c.providers[provider].enabled = false;
      }
      
      return c;
    });
    
    res.json({ success: true });
  } catch (e) {
    logger.error('Error deleting account: %s', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get all accounts
app.get('/api/accounts', async (req, res) => {
  try {
    const cfg = loadConfig();
    const accounts = [];
    const { getTokens } = require('./tokenStore');
    
    // Get Google accounts
    if (cfg.providers?.google?.accounts) {
      for (const acc of cfg.providers.google.accounts) {
        try {
          const tokens = await getTokens('google', acc.alias);
          const connected = !!(tokens?.accessToken || tokens?.refresh_token);
          
          if (connected) {
            logger.debug('Google account %s is connected', acc.alias);
          } else {
            logger.debug('Google account %s is not connected (no valid tokens found)', acc.alias);
          }
          
          accounts.push({
            provider: 'google',
            alias: acc.alias,
            connected,
            redirectUri: acc.redirectUri,
            scopes: acc.scopes,
            tokenExpires: tokens?.expires_at || tokens?.expiresAt
          });
        } catch (error) {
          logger.error('Error checking Google account %s: %s', acc.alias, error.message);
          // Still include the account but mark as not connected
          accounts.push({
            provider: 'google',
            alias: acc.alias,
            connected: false,
            redirectUri: acc.redirectUri,
            scopes: acc.scopes,
            error: error.message
          });
        }
      }
    }
    
    // Get Microsoft accounts
    if (cfg.providers?.microsoft?.accounts) {
      for (const acc of cfg.providers.microsoft.accounts) {
        try {
          const tokens = await getTokens('microsoft', acc.alias);
          // For Microsoft, we need to check both the token cache and the stored tokens
          const hasValidToken = tokens && (
            tokens.accessToken || 
            tokens.refreshToken ||
            (tokens.cache && Object.keys(tokens.cache).length > 0) ||
            (tokens.account && tokens.account.idToken)
          );
          
          if (hasValidToken) {
            logger.debug('Microsoft account %s is connected', acc.alias);
          } else {
            logger.debug('Microsoft account %s is not connected (no valid tokens found)', acc.alias);
          }
          
          accounts.push({
            provider: 'microsoft',
            alias: acc.alias,
            connected: hasValidToken,
            redirectUri: acc.redirectUri,
            scopes: acc.scopes,
            tokenExpires: tokens?.expires_at || tokens?.expiresAt
          });
        } catch (error) {
          logger.error('Error checking Microsoft account %s: %s', acc.alias, error.message);
          // Still include the account but mark as not connected
          accounts.push({
            provider: 'microsoft',
            alias: acc.alias,
            connected: false,
            redirectUri: acc.redirectUri,
            scopes: acc.scopes,
            error: error.message
          });
        }
      }
    }
    
    logger.debug('Returning %d accounts', accounts.length);
    res.json({ accounts });
  } catch (e) {
    logger.error('Error getting accounts: %s', e.message, { stack: e.stack });
    res.status(500).json({ error: 'Failed to load accounts: ' + e.message });
  }
});

// Get account details
app.get('/api/accounts/:provider/:alias', (req, res) => {
  try {
    const { provider, alias } = req.params;
    if (!provider || !alias) return res.status(400).json({ error: 'Missing required fields' });
    if (!['google', 'microsoft'].includes(provider)) return res.status(400).json({ error: 'Invalid provider' });
    
    const cfg = loadConfig();
    const prov = cfg.providers?.[provider];
    if (!prov) return res.status(404).json({ error: 'Provider not found' });
    
    const account = (prov.accounts || []).find(a => a.alias === alias);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    
    // Don't expose sensitive data
    const { refreshToken, ...safeAccount } = account;
    res.json({ account: safeAccount });
  } catch (e) {
    logger.error('Error getting account: %s', e.message);
    res.status(500).json({ error: e.message });
  }
});


// Google OAuth routes
app.get('/auth/google/start/:alias', async (req, res) => {
  try {
    const cfg = loadConfig();
    const url = googleAuth.buildAuthUrl(cfg, req.params.alias);
    res.redirect(url);
  } catch (e) {
    logger.error('Google start error: %s', e.message);
    res.status(400).send('Google auth start failed');
  }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    logger.info('Received Google OAuth callback', { query: req.query });
    const cfg = loadConfig();
    const { code, state, error, error_description } = req.query;
    
    if (error) {
      logger.error('Google OAuth error', { error, error_description, state });
      return res.redirect(`/accounts.html?error=oauth_failed&message=${encodeURIComponent(error_description || error)}`);
    }
    
    if (!code) {
      logger.error('Missing authorization code in Google OAuth callback');
      return res.redirect('/accounts.html?error=missing_code');
    }
    
    await googleAuth.handleCallback(cfg, code, state);
    logger.info('Google OAuth flow completed successfully');
    return res.redirect('/accounts.html?provider=google&status=connected');
    
  } catch (e) {
    logger.error('Google OAuth callback failed', { 
      error: e.message, 
      stack: e.stack,
      query: req.query 
    });
    const errorMessage = encodeURIComponent(e.message || 'Authentication failed');
    res.redirect(`/accounts.html?error=auth_failed&message=${errorMessage}`);
  }
});

// Microsoft OAuth routes
app.get('/auth/microsoft/start/:alias', async (req, res) => {
  try {
    const cfg = loadConfig();
    const url = await msAuth.buildAuthUrl(cfg, req.params.alias);
    res.redirect(url);
  } catch (e) {
    logger.error('MS start error: %s', e.message);
    res.status(400).send('Microsoft auth start failed');
  }
});

app.get('/auth/microsoft/callback', async (req, res) => {
  try {
    const cfg = loadConfig();
    const { code, state } = req.query;
    await msAuth.handleCallback(cfg, code, state);
    res.redirect('/accounts.html?provider=microsoft&status=connected');
  } catch (e) {
    logger.error('MS callback error: %s', e.message);
    res.status(400).send('Microsoft auth failed');
  }
});

function start() {
  const cfg = loadConfig();
  const port = cfg?.app?.port || 5178;
  app.listen(port, () => {
    logger.info(`Docfinder server running on http://localhost:${port}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
