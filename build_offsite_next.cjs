// Builds the next offsite queue: every job from the current backlog whose
// status is non-terminal and still under MAX_ATTEMPTS (these pick up fixes
// 22-27), followed by the newly-deferred batch2 pile. Run after offsite v6 exits.
const fs = require('fs');
const D = __dirname + '/';
const TERMINAL = /^(SUBMITTED|ALREADY-APPLIED|skip-workday|skip-login|skip-listed|skip-account)$/;
const MAX = 3;
const recs = fs.readFileSync(D + 'offsite3.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const last = new Map(), att = new Map();
for (const r of recs) {
  last.set(r.id, r);
  // err:* / scan-failed are process hiccups, not attempts - same rule offsite3 uses
  if (!/^err:|^scan-failed$|^READY$/.test(String(r.status))) att.set(r.id, (att.get(r.id) || 0) + 1);
}
const backlog = JSON.parse(fs.readFileSync(D + 'offsite_backlog.json', 'utf8'));
const retry = backlog.filter(j => {
  const r = last.get(j.id);
  return r && !TERMINAL.test(r.status) && (att.get(j.id) || 0) < MAX;
});
const b2 = JSON.parse(fs.readFileSync(D + 'offsite_batch2.json', 'utf8'));
const seen = new Set(retry.map(j => j.id));
const out = retry.concat(b2.filter(j => !seen.has(j.id) && !TERMINAL.test(String((last.get(j.id) || {}).status))));
fs.writeFileSync(D + 'offsite_next.json', JSON.stringify(out));
const h = {};
for (const j of retry) { const s = last.get(j.id).status; h[s] = (h[s] || 0) + 1; }
console.log('retry-from-backlog', retry.length, '+ batch2', out.length - retry.length, '= offsite_next.json', out.length);
Object.entries(h).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(String(v).padStart(4), k));
