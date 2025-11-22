const path = require('path');
const fs = require('fs');
const fg = require('fast-glob');
const Fuse = require('fuse.js');
const logger = require('../logger');

async function searchLocalByName(name, localCfg) {
  const includeDirs = (localCfg?.include || []).filter((p) => fs.existsSync(p));
  if (includeDirs.length === 0) {
    logger.warn('No existing local include directories configured');
    return [];
  }

  const patterns = includeDirs.map((dir) => path.join(dir, '**', '*'));
  const ignore = localCfg?.excludeGlobs || [];
  const entries = await fg(patterns, {
    onlyFiles: true,
    unique: true,
    ignore,
    followSymbolicLinks: !!localCfg?.followSymlinks,
    stats: false,
    dot: false,
  });

  const files = entries.map((filePath) => {
    let stat;
    try { stat = fs.statSync(filePath); } catch { stat = null; }
    return {
      id: `local:${filePath}`,
      title: path.basename(filePath),
      source: 'local',
      account: 'this-mac',
      path: filePath,
      url: filePath,
      modified: stat ? stat.mtimeMs : null,
      size: stat ? stat.size : null,
    };
  });

  if (!name || name.trim() === '') return files.slice(0, 2000);

  const fuse = new Fuse(files, {
    keys: ['title'],
    threshold: 0.4,
    ignoreLocation: true,
    includeScore: true,
  });
  const results = fuse.search(name);

  return results
    .map((r) => ({ ...r.item, score: r.score }))
    .sort((a, b) => (a.score ?? 1) - (b.score ?? 1));
}

module.exports = { searchLocalByName };
