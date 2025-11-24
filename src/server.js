const express = require('express');
const path = require('path');
const fs = require('fs');

// Application modules
const logger = require('./logger');
const { getTokens, deleteTokens } = require('./tokenStore');
const config = require('./config');
const { unifiedSearchByName } = require('./search/unified');
const { buildAuthUrl, handleCallback } = require('./auth/microsoft');
const googleAuth = require('./auth/google');
const msAuth = require('./auth/microsoft');

// Load .env file at startup
function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();
        
        // Handle JSON values
        if ((value.startsWith('[') && value.endsWith(']')) || 
            (value.startsWith('{') && value.endsWith('}'))) {
          try {
            process.env[key] = value; // Store as string, we'll parse when needed
          } catch (e) {
            process.env[key] = value;
          }
        } else {
          process.env[key] = value;
        }
      }
    });
  }
}

// Initialize environment
loadEnvFile();

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
// In server.js, around line 342
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

    const envVarName = `${provider.toUpperCase()}_ACCOUNTS`;
    const currentAccounts = process.env[envVarName] ? JSON.parse(process.env[envVarName]) : [];
    
    // Check if account already exists
    const existingIndex = currentAccounts.findIndex(a => a.alias === account.alias);
    const updatedAccounts = [...currentAccounts];
    
    if (existingIndex >= 0) {
      // Update existing account
      updatedAccounts[existingIndex] = {
        ...updatedAccounts[existingIndex],
        ...account
      };
    } else {
      // Add new account
      updatedAccounts.push(account);
    }

    // Update the .env file
    const envPath = path.join(__dirname, '..', '.env');
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    
    // Update or add the accounts line
    const accountsLine = `${envVarName}=${JSON.stringify(updatedAccounts)}`;
    const envVarRegex = new RegExp(`^${envVarName}=.*$`, 'm');
    
    if (envVarRegex.test(envContent)) {
      envContent = envContent.replace(envVarRegex, accountsLine);
    } else {
      envContent = `${envContent}\n${accountsLine}\n`;
    }
    
    fs.writeFileSync(envPath, envContent, 'utf8');
    
    // Update process.env
    process.env[envVarName] = JSON.stringify(updatedAccounts);
    
    res.json({ success: true });
  } catch (e) {
    logger.error('Error saving account:', e);
    res.status(500).json({ 
      error: e.message || 'Failed to save account',
      details: process.env.NODE_ENV === 'development' ? e.stack : undefined
    });
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
    const decodedAlias = decodeURIComponent(alias);
    const envVarName = `${provider.toUpperCase()}_ACCOUNTS`;
    
    logger.info(`Deleting account: ${provider}/${decodedAlias}`);
    
    if (!process.env[envVarName]) {
      return res.status(404).json({ error: 'No accounts found for this provider' });
    }

    const accounts = JSON.parse(process.env[envVarName]);
    const updatedAccounts = accounts.filter(acc => acc.alias !== decodedAlias);
    
    if (updatedAccounts.length === accounts.length) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Update .env file
    const envPath = path.join(__dirname, '..', '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');
    
    if (updatedAccounts.length > 0) {
      const accountsLine = `${envVarName}=${JSON.stringify(updatedAccounts)}`;
      const envVarRegex = new RegExp(`^${envVarName}=.*$`, 'm');
      envContent = envVarRegex.test(envContent)
        ? envContent.replace(envVarRegex, accountsLine)
        : `${envContent}\n${accountsLine}\n`;
    } else {
      // Remove the line if no accounts left
      const envVarRegex = new RegExp(`^${envVarName}=.*(\r?\n|$)`, 'm');
      envContent = envContent.replace(envVarRegex, '');
    }
    
    // Write changes back to .env file
    fs.writeFileSync(envPath, envContent, 'utf8');
    
    // Update process.env
    if (updatedAccounts.length > 0) {
      process.env[envVarName] = JSON.stringify(updatedAccounts);
    } else {
      delete process.env[envVarName];
    }
    
    // Delete tokens for this account
    await deleteTokens(provider, decodedAlias);

    logger.info(`Successfully deleted account: ${provider}/${decodedAlias}`);
    
    res.json({ 
      success: true,
      message: 'Account deleted successfully'
    });
  } catch (error) {
    logger.error('Error deleting account:', {
      error: error.message,
      stack: error.stack,
      provider: req.params.provider,
      alias: req.params.alias
    });
    res.status(500).json({ 
      error: error.message || 'Failed to delete account',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * Get all accounts with their token status
 * Returns accounts from both Google and Microsoft providers
 */
// Helper function to parse accounts from environment variable
const parseAccounts = (envVar) => {
  if (!envVar) return [];
  try {
    return typeof envVar === 'string' ? JSON.parse(envVar) : [];
  } catch (e) {
    logger.error('Error parsing accounts from env:', e);
    return [];
  }
};

app.get('/api/accounts', async (req, res) => {
  try {
    const accounts = {
      google: [],
      microsoft: []
    };

    // Get Google accounts from environment
    const googleAccounts = parseAccounts(process.env.GOOGLE_ACCOUNTS);
    if (googleAccounts.length > 0) {
      accounts.google = await Promise.all(
        googleAccounts.map(async (account) => {
          try {
            const tokens = await getTokens('google', account.alias);
            return {
              alias: account.alias,
              hasToken: !!(tokens?.access_token)
            };
          } catch (error) {
            logger.error(`Error getting tokens for Google account ${account.alias}:`, error);
            return {
              alias: account.alias,
              hasToken: false
            };
          }
        })
      );
    }

    // Get Microsoft accounts from environment
    const microsoftAccounts = parseAccounts(process.env.MICROSOFT_ACCOUNTS);
    if (microsoftAccounts.length > 0) {
      accounts.microsoft = await Promise.all(
        microsoftAccounts.map(async (account) => {
          try {
            const tokens = await getTokens('microsoft', account.alias);
            return {
              alias: account.alias,
              hasToken: !!(tokens?.access_token)
            };
          } catch (error) {
            logger.error(`Error getting tokens for Microsoft account ${account.alias}:`, error);
            return {
              alias: account.alias,
              hasToken: false
            };
          }
        })
      );
    }
    
    res.json(accounts);
  } catch (error) {
    logger.error('Error in /api/accounts:', {
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json({ 
      error: 'Failed to load accounts',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
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

// Save config is no longer the primary method for account management
// Keeping it for backward compatibility
function saveConfig(updater) {
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

// Keep for backward compatibility
function updateEnvironmentVariables(config) {
  // This function is now a no-op as we manage env vars directly
  logger.debug('Environment variables are now managed directly in .env file');
}

// At the very bottom of server.js, after all route definitions
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
}

// Export the Express app for testing
module.exports = { app };

