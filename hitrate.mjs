// Hit rate the way it actually matters: submissions per job we were ever able
// to attempt. Workday / login walls / denylisted hosts are out of scope by
// policy, so counting them in the denominator hides real performance.
import fs from 'fs';
const rd = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const OUT_OF_SCOPE = /^(skip-workday|skip-login|skip-listed|skip-account)$/;
const SUCCESS = /^(SUBMITTED|ALREADY-APPLIED)$/;

const batch = process.env.BATCH ? new Set(JSON.parse(fs.readFileSync(process.env.BATCH, 'utf8')).map(j => j.id)) : null;
const SINCE = Number(process.env.SINCE_LINE || 0);

for (const [name, file] of [['offsite3', 'offsite3.jsonl'], ['apply3', 'applied3.jsonl']]) {
  let recs = rd(file);
  if (name === 'offsite3' && SINCE) recs = recs.slice(SINCE);
  if (batch) recs = recs.filter(r => batch.has(r.id));
  if (!recs.length) continue;
  // last record per job wins - earlier passes are superseded
  const last = new Map(); for (const r of recs) last.set(r.id, r);
  const rows = [...last.values()];
  const tally = {}; rows.forEach(r => tally[r.status] = (tally[r.status] || 0) + 1);
  const oos = rows.filter(r => OUT_OF_SCOPE.test(r.status)).length;
  const hit = rows.filter(r => SUCCESS.test(r.status)).length;
  const deferred = name === 'apply3' ? rows.filter(r => r.status === 'offsite-deferred').length : 0;
  const addressable = rows.length - oos - deferred;
  console.log(`\n== ${name} (${rows.length} jobs${SINCE && name === 'offsite3' ? `, since line ${SINCE}` : ''})`);
  Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(4)} ${k}`));
  console.log(`  --- out-of-scope(workday/login/listed/account)=${oos}${deferred ? ` deferred=${deferred}` : ''} addressable=${addressable} submitted=${hit}`);
  console.log(`  >>> HIT RATE = ${addressable ? (100 * hit / addressable).toFixed(1) : '0.0'}% of addressable   (${(100 * hit / rows.length).toFixed(1)}% of all)`);
}
