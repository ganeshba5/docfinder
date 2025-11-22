const { searchLocalByName } = require('../connectors/local');
const { searchGoogleByName } = require('../connectors/google');
const { searchMicrosoftByName } = require('../connectors/microsoft');

function dedupe(results) {
  const seen = new Map();
  const keyOf = (r) => `${r.source}:${(r.id||'')}` || `${r.title}:${r.size}:${r.modified}`;
  for (const r of results) {
    const k = keyOf(r);
    if (!seen.has(k)) seen.set(k, r);
  }
  return Array.from(seen.values());
}

function rank(results, query) {
  const q = (query || '').toLowerCase();
  return results
    .map((r) => {
      const title = (r.title || '').toLowerCase();
      let score = 1.0;
      if (q) {
        if (title === q) score = 0.0;
        else if (title.includes(q)) score = 0.2;
        else score = r.score ?? 0.6;
      }
      const recencyBoost = r.modified ? (Date.now() - r.modified) / (1000*60*60*24*365) : 5; // years
      return { ...r, rank: score + Math.min(recencyBoost, 5) * 0.02 };
    })
    .sort((a, b) => (a.rank ?? 1) - (b.rank ?? 1))
    .slice(0, 200);
}

async function unifiedSearchByName(name, cfg, opts = {}) {
  const includeSources = Array.isArray(opts.includeSources) ? opts.includeSources : [];
  const includeAccounts = Array.isArray(opts.includeAccounts) ? opts.includeAccounts : [];

  const wantsLocal = includeSources.length === 0 || includeSources.includes('local');
  const wantsGoogle = includeSources.length === 0 || includeSources.some(s => s.startsWith('google') || s === 'gmail-attachment');
  const wantsMicrosoft = includeSources.length === 0 || includeSources.some(s => s.startsWith('microsoft'));

  const tasks = [];
  if (wantsLocal) tasks.push(searchLocalByName(name, cfg.local)); else tasks.push(Promise.resolve([]));
  if (wantsGoogle) tasks.push(searchGoogleByName(name, cfg.providers?.google)); else tasks.push(Promise.resolve([]));
  if (wantsMicrosoft) tasks.push(searchMicrosoftByName(name, cfg.providers?.microsoft)); else tasks.push(Promise.resolve([]));

  const [local, google, ms] = await Promise.all(tasks);

  const all = [...local, ...google, ...ms];
  let filtered = all;
  if (includeAccounts.length) {
    filtered = filtered.filter(r => r.account && includeAccounts.includes(r.account));
  }
  if (includeSources.length) {
    filtered = filtered.filter(r => r.source && includeSources.includes(r.source));
  }
  const unique = dedupe(filtered);
  return rank(unique, name);
}

module.exports = { unifiedSearchByName };
