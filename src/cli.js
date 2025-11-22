#!/usr/bin/env node
const { Command } = require('commander');
const { loadConfig } = require('./config');
const { unifiedSearchByName } = require('./search/unified');

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
      console.log(`${r.source}\t${r.title}\t${modified}\t${r.path || r.url}`);
    }
    if (results.length === 0) {
      console.log('No matches');
    }
  });

program.parse();
