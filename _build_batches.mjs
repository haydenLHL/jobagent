import fs from 'fs';
const rows = fs.readFileSync('applied3.jsonl','utf8').trim().split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
const target = new Set(JSON.parse(fs.readFileSync('jr_jobs.json','utf8')).map(j => j.id));
const done = fs.existsSync('offsite3.jsonl')
  ? new Set(fs.readFileSync('offsite3.jsonl','utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).id))
  : new Set();
// last record per id wins (ledger is append-only, ids can repeat across runs)
const last = new Map(); rows.forEach(r => last.set(r.id, r));
const pick = st => [...last.values()].filter(r => st.includes(r.status) && target.has(r.id) && !done.has(r.id));
const mk = rs => rs.map(r => ({ id: r.id, txt: r.title }));
const primary = pick(['offsite-deferred']);
const bonus   = pick(['skip-external-redirect','no-apply-button']);
fs.writeFileSync('offsite_batch.json', JSON.stringify(mk(primary)));
fs.writeFileSync('offsite_bonus.json', JSON.stringify(mk(bonus)));
console.log('primary (offsite-deferred):', primary.length, '-> offsite_batch.json');
console.log('bonus (ext-redirect+no-btn):', bonus.length, '-> offsite_bonus.json');
console.log('already done in offsite3.jsonl:', done.size);
