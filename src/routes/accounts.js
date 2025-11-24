const express = require('express');
const router = express.Router();
const { readEnv, writeEnv } = require('../utils/envManager');

// Get all accounts
router.get('/', async (req, res) => {
  try {
    const env = await readEnv();
    res.json({
      google: env.GOOGLE_ACCOUNTS || [],
      microsoft: env.MICROSOFT_ACCOUNTS || []
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load accounts' });
  }
});

// Add or update an account
router.post('/', async (req, res) => {
  try {
    const { provider, alias, clientId, clientSecret, redirectUri, tenantId } = req.body;
    
    if (!provider || !alias || !clientId || !clientSecret || !redirectUri) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const env = await readEnv();
    const accountsKey = `${provider.toUpperCase()}_ACCOUNTS`;
    const accounts = JSON.parse(env[accountsKey] || '[]');
    
    // Update or add account
    const existingIndex = accounts.findIndex(a => a.alias === alias);
    const accountData = { alias, clientId, clientSecret, redirectUri };
    if (provider === 'microsoft' && tenantId) {
      accountData.tenantId = tenantId;
    }

    if (existingIndex >= 0) {
      accounts[existingIndex] = accountData;
    } else {
      accounts.push(accountData);
    }

    // Save back to .env
    env[accountsKey] = JSON.stringify(accounts);
    await writeEnv(env);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save account' });
  }
});

// Delete an account
router.delete('/:provider/:alias', async (req, res) => {
  try {
    const { provider, alias } = req.params;
    const env = await readEnv();
    const accountsKey = `${provider.toUpperCase()}_ACCOUNTS`;
    let accounts = JSON.parse(env[accountsKey] || '[]');
    
    const initialLength = accounts.length;
    accounts = accounts.filter(a => a.alias !== alias);
    
    if (accounts.length < initialLength) {
      env[accountsKey] = JSON.stringify(accounts);
      await writeEnv(env);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Account not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;
