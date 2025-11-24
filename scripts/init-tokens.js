// scripts/init-tokens.js
const fs = require('fs').promises;
const path = require('path');
const config = require('../src/config');

async function initTokensFile() {
  try {
    await fs.writeFile(
      config.tokenStorage.filePath,
      JSON.stringify({}, null, 2)
    );
    console.log(`Created tokens file at ${config.tokenStorage.filePath}`);
  } catch (error) {
    console.error('Error initializing tokens file:', error);
    process.exit(1);
  }
}

initTokensFile();
