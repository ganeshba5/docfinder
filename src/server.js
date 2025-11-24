const express = require('express');
const path = require('path');
const logger = require('./logger');
const googleAuth = require('./auth/google');
const msAuth = require('./auth/microsoft');
const { getTokens, deleteTokens } = require('./tokenStore');
const config = require('./config');
const { unifiedSearchByName } = require('./search/unified');
const { buildAuthUrl, handleCallback } = require('./auth/microsoft');

const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Token status endpoint
app.get('/api/accounts/token/:provider/:alias', async (req, res) => {
  try {
    const { provider, alias } = req.params;
    logger.debug(`Token check for ${provider}:${alias}`);
    const xtokens = await getTokens(provider, alias);
    logger.debug(`Tokens for ${provider}:${alias}: ${xtokens ? 'EXISTS' : 'NULL'}`);
    if (!provider || !alias) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    if (!['google', 'microsoft'].includes(provider)) {
      return res.status(400).json({ error: 'Invalid provider' });
    }

    const tokens = await getTokens(provider, alias);
    const hasValidToken = tokens && 
                         tokens.access_token && 
                         (!tokens.expiry_date || tokens.expiry_date > Date.now());
    
    res.json({
      hasToken: !!hasValidToken,
      expiresAt: tokens?.expiry_date,
      provider,
      alias
    });
  } catch (error) {
    logger.error('Error checking token status:', error);
    res.status(500).json({ 
      error: 'Failed to check token status',
      details: error.message 
    });
  }
});

// Google OAuth routes
app.get('/auth/google/start/:alias', (req, res) => {
  try {
    const { alias } = req.params;
    const url = googleAuth.buildAuthUrl(config, alias);
    res.redirect(url);
  } catch (e) {
    logger.error('Error starting Google auth:', e);
    res.status(400).send(`Error starting Google authentication: ${e.message}`);
  }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    logger.info('Google OAuth callback received', { query: req.query });
    const { code, state, error, error_description } = req.query;
    
    if (error) {
      throw new Error(`Google OAuth error: ${error_description || error}`);
    }
    
    if (!code) {
      throw new Error('No authorization code received from Google');
    }
    
    // Parse the state to get provider and alias
    let stateData;
    try {
      stateData = JSON.parse(state);
    } catch (e) {
      throw new Error('Invalid state parameter');
    }

    const { provider = 'google', alias } = stateData;
    
    if (!alias) {
      throw new Error('Missing alias in state');
    }

    // Handle the OAuth callback and store tokens
    try {
      const result = await googleAuth.handleCallback(config, code, state);
      
      if (!result || !result.success) {
        throw new Error('Failed to complete Google OAuth flow');
      }

      logger.info('Google OAuth successful for alias:', alias);
      
      // Close the popup and refresh the parent window
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Authentication Successful</title>
          <script>
            if (window.opener) {
              // Notify parent window that authentication was successful
              window.opener.postMessage({ 
                type: 'oauth-callback', 
                success: true,
                provider: '${provider}',
                alias: '${alias}'
              }, window.location.origin);
              // Close the popup after a short delay to ensure the message is sent
              setTimeout(() => window.close(), 500);
            } else {
              // Fallback in case the popup was opened in a new tab
              window.location.href = '/accounts.html';
            }
          </script>
        </head>
        <body>
          <p>Authentication successful! You can close this window.</p>
          <button onclick="window.close()">Close Window</button>
        </body>
        </html>
      `);
    } catch (authError) {
      logger.error('Error in Google auth callback:', authError);
      throw authError;
    }
  } catch (e) {
    logger.error('Error in Google OAuth callback:', e);
    res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authentication Failed</title>
        <script>
          if (window.opener) {
            window.opener.postMessage({ 
              type: 'oauth-callback', 
              success: false, 
              error: '${e.message.replace(/'/g, "\\'")}'
            }, window.location.origin);
          }
        </script>
      </head>
      <body>
        <h2>Authentication Failed</h2>
        <p>${e.message}</p>
        <button onclick="window.close()">Close Window</button>
      </body>
      </html>
    `);
  }
});

// Microsoft OAuth routes
app.get('/auth/microsoft/start/:alias', async (req, res) => {
  try {
    const { alias } = req.params;
    if (!alias) {
      throw new Error('Missing alias parameter');
    }
    logger.info('Starting Microsoft OAuth flow', { alias });
    const url = await msAuth.buildAuthUrl(config, alias);
    logger.debug('Redirecting to Microsoft auth URL');
    res.redirect(url);
  } catch (e) {
    logger.error('Error starting Microsoft auth:', { error: e.message, stack: e.stack });
    res.status(400).send(`Error starting Microsoft authentication: ${e.message}`);
  }
});

// Microsoft OAuth callback
app.get('/auth/microsoft/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  let stateObj;

  try {
    // Parse the state parameter to get the alias
    stateObj = state ? JSON.parse(decodeURIComponent(state)) : {};
  } catch (e) {
    console.error('Error parsing state:', e);
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <script>
            alert('Invalid state parameter');
            window.close();
          </script>
        </head>
      </html>
    `);
  }

  const { alias } = stateObj;
  if (!alias) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <script>
            alert('Missing alias in state');
            window.close();
          </script>
        </head>
      </html>
    `);
  }

  try {
    const config = require('./config');
    const result = await msAuth.handleCallback(config, code, state);
    
    if (result?.success) {
      // Close the popup and redirect the parent window
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <script>
              // Notify the parent window that authentication was successful
              if (window.opener) {
                window.opener.postMessage({
                  type: 'AUTH_SUCCESS',
                  provider: 'microsoft',
                  alias: '${alias.replace(/'/g, "\\'")}'
                }, window.location.origin);
              }
              // Close the popup
              window.close();
            </script>
          </head>
          <body>
            <p>Authentication successful! You can close this window if it doesn't close automatically.</p>
            <script>
              // Fallback in case window.close() is blocked
              setTimeout(() => {
                window.close();
              }, 2000);
            </script>
          </body>
        </html>
      `);
    } else {
      const error = result?.error || 'Unknown error during authentication';
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <script>
              alert('Authentication failed: ${error.replace(/'/g, "\\'")}');
              window.close();
            </script>
          </head>
        </html>
      `);
    }
  } catch (error) {
    console.error('Microsoft OAuth callback error:', error);
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <script>
            alert('Error: ${error.message.replace(/'/g, "\\'")}');
            window.close();
          </script>
        </head>
      </html>
    `);
  }
});

// In your main server file, add:
app.get('/auth/microsoft', (req, res) => {
  const { alias } = req.query;
  if (!alias) {
    return res.status(400).send('Alias parameter is required');
  }
  
  const config = require('./config');
  try {
    const authUrl = buildAuthUrl(config, alias);
    res.redirect(authUrl);
  } catch (error) {
    res.status(500).send(`Error generating auth URL: ${error.message}`);
  }
});

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
    // Convert accountsFilter from "provider:alias" format to just aliases
    const accountAliases = accountsFilter.map(acc => {
      const parts = acc.split(':');
      return parts.length > 1 ? parts[1] : acc; // Extract just the alias part
    });

    let results = await unifiedSearchByName(name, config, {
      includeSources: sourcesFilter,
      includeAccounts: accountAliases, // Pass just the aliases
    });
    
    logger.info('Search results:', { 
      resultCount: results.length,
      sources: [...new Set(results.map(r => r.source))]
    });
    
    res.json({ results });
  } catch (e) {
    logger.error('Search error:', e);
    res.status(500).json({ error: 'Search failed', details: e.message });
  }
});

// Add or update account
app.post('/api/accounts', (req, res) => {
  try {
    const { provider, account } = req.body || {};
    if (!provider || !account || !account.alias) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!['google', 'microsoft'].includes(provider)) {
      return res.status(400).json({ error: 'Invalid provider' });
    }

    const cfg = saveConfig((c) => {
      // Initialize providers object if it doesn't exist
      if (!c.providers) c.providers = {};
      
      // Initialize provider if it doesn't exist
      if (!c.providers[provider]) {
        c.providers[provider] = { enabled: true, accounts: [] };
      }
      
      const prov = c.providers[provider];
      const accounts = prov.accounts || [];
      const idx = accounts.findIndex(a => a.alias === account.alias);
      
      if (idx === -1) {
        // Add new account
        accounts.push(account);
      } else {
        // Update existing account
        const current = accounts[idx];
        accounts[idx] = { ...current, ...account };
      }
      
      prov.accounts = accounts;
      return c;
    });
    
    res.json({ success: true });
  } catch (e) {
    logger.error('Error saving account:', e);
    res.status(500).json({ error: e.message || 'Failed to save account' });
  }
});

// Disconnect account (remove tokens but keep configuration)
app.post('/api/accounts/:provider/:alias/disconnect', async (req, res) => {
  try {
    const { provider, alias } = req.params;
    if (!provider || !alias) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Delete the tokens for this account
    await deleteTokens(provider, alias);
    
    // Verify the tokens were actually deleted
    const tokens = await getTokens(provider, alias);
    if (tokens) {
      throw new Error('Failed to delete tokens');
    }
    
    logger.info(`Successfully disconnected ${provider} account:`, alias);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error disconnecting account:', error);
    res.status(500).json({ 
      error: 'Failed to disconnect account', 
      message: error.message 
    });
  }
});

// Delete account
app.delete('/api/accounts/:provider/:alias', async (req, res) => {
  try {
    const { provider, alias } = req.params;
    if (!provider || !alias) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    if (!['google', 'microsoft'].includes(provider)) {
      return res.status(400).json({ error: 'Invalid provider' });
    }

    // First try to delete tokens
    try {
      await deleteTokens(provider, alias);
      logger.info(`Deleted tokens for ${provider} account:`, alias);
    } catch (tokenError) {
      logger.warn(`Error deleting tokens for ${provider} account ${alias}:`, tokenError);
      // Continue with account deletion even if token deletion fails
    }

    // Then delete the account from config
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
  } catch (error) {
    logger.error('Error deleting account:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to delete account' 
    });
  }
});

// Get all accounts with token status
app.get('/api/accounts', async (req, res) => {
  try {
    const accounts = {
      google: [],
      microsoft: []
    };

    // Get accounts from config
    if (config.providers) {
      for (const [provider, providerConfig] of Object.entries(config.providers)) {
        if (providerConfig?.accounts?.length) {
          // Check token status for each account
          for (const account of providerConfig.accounts) {
            try {
              const tokens = await getTokens(provider, account.alias);
              accounts[provider].push({
                ...account,
                hasToken: !!(tokens?.access_token && 
                           (!tokens.expiry_date || tokens.expiry_date > Date.now()))
              });
            } catch (error) {
              logger.error(`Error checking token status for ${provider} account ${account.alias}:`, error);
              accounts[provider].push({
                ...account,
                hasToken: false
              });
            }
          }
        }
      }
    }

    res.json(accounts);
  } catch (error) {
    logger.error('Error getting accounts:', error);
    res.status(500).json({ 
      error: 'Failed to get accounts',
      details: error.message 
    });
  }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message 
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // Don't exit for now, but you might want to restart in production
  // process.exit(1);
});

function saveConfig(updater) {
  const fs = require('fs');
  const path = require('path');
  const configPath = path.join(__dirname, 'config.json');
  
  try {
    let currentConfig = {};
    if (fs.existsSync(configPath)) {
      currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    
    const newConfig = updater({ ...currentConfig });
    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
    return newConfig;
  } catch (error) {
    logger.error('Error saving config:', error);
    throw error;
  }
}

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

module.exports = app;

