const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const logger = require('./logger');

const CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'config.yaml');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = YAML.parse(raw);
    return cfg;
  } catch (e) {
    logger.error('Failed to load config at %s: %s', CONFIG_PATH, e.message);
    throw e;
  }
}

module.exports = { loadConfig, CONFIG_PATH };
