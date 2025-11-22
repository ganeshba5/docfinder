const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { CONFIG_PATH, loadConfig } = require('./config');

function saveConfig(modifier) {
  const cfg = loadConfig();
  const newCfg = modifier ? modifier(cfg) || cfg : cfg;
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const yaml = YAML.stringify(newCfg);
  fs.writeFileSync(CONFIG_PATH, yaml, 'utf8');
  return newCfg;
}

module.exports = { saveConfig };
