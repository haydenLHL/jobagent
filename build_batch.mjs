// Build the next run's queue: everything from the fresh harvest that is not
// finished, newest first, retries included. SIZE=n caps it.
import fs from 'fs';
const rd = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const TERMINAL = /^(SUBMITTED|ALREADY-APPLIED|skip-workday|skip-login|skip-listed|skip-account)$/;
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
const SIZE = Number(process.env.SIZE || 40);
const SRC = process.env.SRC || 'jr_jobs.json';
const OUT = process.env.OUT || 'batch.json';

const term = new Set(), att = new Map();
for (const r of [...rd('offsite3.jsonl'), ...rd('applied3.jsonl')]) {
  if (TERMINAL.test(String(r.status))) term.add(r.id);
  else if (!/^err:|^scan-failed$|^READY$|^offsite-deferred$/.test(String(r.status))) att.set(r.id, (att.get(r.id) || 0) + 1);
}
const jobs = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const pick = jobs.filter(j => !term.has(j.id) && (att.get(j.id) || 0) < MAX_ATTEMPTS);
const out = pick.slice(0, SIZE);
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const retries = out.filter(j => att.get(j.id)).length;
console.log(`${OUT}: ${out.length} jobs (${retries} retries, ${out.length - retries} never attempted) | pool=${pick.length} of ${jobs.length}; terminal=${term.size}`);
