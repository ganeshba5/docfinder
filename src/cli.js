#!/usr/bin/env node
const { Command } = require('commander');
const { loadConfig } = require('./config');
const { unifiedSearchByName } = require('./search/unified');
const logger = require('./logger');

const program = new Command();
program
  .name('docfinder')
  .description('Find documents by name across local, Google, and Microsoft sources')
  .version('0.1.0');

program
  .command('search')
  .description('Search by filename')
  .requiredOption('-n, --name <name>', 'Name to search for')
  .action(async (opts) => {
    const cfg = loadConfig();
    const results = await unifiedSearchByName(opts.name, cfg);
    for (const r of results) {
      const modified = r.modified ? new Date(r.modified).toISOString() : '-';
      logger.debug('Search result', { source: r.source, title: r.title, modified, path: r.path || r.url });
      // For CLI, still output to console for user visibility
      console.log(`${r.source}\t${r.title}\t${modified}\t${r.path || r.url}`);
    }
    if (results.length === 0) {
      logger.debug('No search matches found', { query: opts.name });
      console.log('No matches');
    }
  });

program.parse();
