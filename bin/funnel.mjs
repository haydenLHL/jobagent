// Pipeline funnel, latest record per job id. The old status.sh counted raw
// ledger lines (a job retried 3x counted 3x) and said nothing about work that
// was never attempted - 1098 offsite-deferred jobs sat untouched for days.
// Usage: node bin/funnel.mjs [queue.json]   (default: newest jr_jobs*.json)
import fs from 'fs';
process.chdir(`${process.env.HOME}/.jobagent`);
const rd = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const latest = recs => { const m = new Map(); for (const r of recs) m.set(r.id, r); return m; };
const A = latest(rd('applied3.jsonl')), O = latest(rd('offsite3.jsonl'));
const OK = s => /^(SUBMITTED|ALREADY-APPLIED)$/.test(String(s));
const tally = (m, ids) => { const c = {}; for (const id of ids ?? m.keys()) { const r = m.get(id); if (!r) continue; const s = String(r.status).replace(/:.*/, ''); c[s] = (c[s] || 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]); };
const show = (t, rows) => { console.log(`\n== ${t}`); rows.forEach(([k, v]) => console.log(String(v).padStart(6), k)); };

const qf = process.argv[2] || fs.readdirSync('.').filter(f => /^jr_jobs.*\.json$/.test(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const q = qf ? JSON.parse(fs.readFileSync(qf, 'utf8')).map(j => j.id) : [];
const everOK = new Set([...A.values(), ...O.values()].filter(r => OK(r.status)).map(r => r.id));
console.log(`queue ${qf}: ${q.length} jobs | not yet run by apply3: ${q.filter(id => !A.has(id)).length}`);

show('EASY APPLY (applied3, latest per id)', tally(A));
show('AUTOFILL (offsite3, latest per id)', tally(O));

const deferred = [...A.values()].filter(r => r.status === 'offsite-deferred');
const untried = deferred.filter(r => !O.has(r.id));
const dropped = [...A.values()].filter(r => /^(skip-external-redirect|no-apply-button)$/.test(r.status) && !O.has(r.id));
console.log(`\n== backlog`);
console.log(String(untried.length).padStart(6), 'offsite-deferred, never attempted by offsite3');
console.log(String(dropped.length).padStart(6), 'skip-external-redirect/no-apply-button, handled by NEITHER pass');
const stale = [...O.values()].filter(r => r.status === 'too-sparse-refused' && !r.sparse).length;
console.log(String(stale).padStart(6), 'too-sparse-refused recorded before the sparse diagnostic existed (retry candidates)');
console.log(`\nsubmitted/already-applied (unique ids, both ledgers): ${everOK.size}`);
console.log('(JobRight\'s Applied counter is the authoritative number.)');
