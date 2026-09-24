// Narrow apply3 follow-up: only jobs whose last status is a real in-modal
// failure (not a skip, not a deferral) and that are still under MAX_ATTEMPTS.
// These are what fixes 28 (Submit Application matcher) and 29 (sparse
// diagnostics) plus the new learned.json answers actually change.
const fs = require('fs');
const D = __dirname + '/';
const TERMINAL = /^(SUBMITTED|ALREADY-APPLIED|skip-listed|offsite-deferred)$/;
const WANT = /^(no-submit-btn|too-sparse-refused|needs-inference|submit-unconfirmed)$/;
const MAX = 3;
const recs = fs.readFileSync(D + 'applied3.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const last = new Map(), att = new Map();
for (const r of recs) { last.set(r.id, r); if (!/^err:/.test(String(r.status))) att.set(r.id, (att.get(r.id) || 0) + 1); }
const q = JSON.parse(fs.readFileSync(D + 'run22_queue.json', 'utf8'));
const out = q.filter(j => {
  const r = last.get(j.id);
  return r && !TERMINAL.test(r.status) && WANT.test(r.status) && (att.get(j.id) || 0) < MAX;
});
fs.writeFileSync(D + 'apply3_sb.json', JSON.stringify(out));
const h = {};
for (const j of out) { const s = last.get(j.id).status; h[s] = (h[s] || 0) + 1; }
console.log('apply3_sb.json', out.length);
Object.entries(h).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(String(v).padStart(4), k));
