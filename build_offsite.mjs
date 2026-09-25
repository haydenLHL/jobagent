// Build offsite_batch.json: the jobs EASY APPLY (apply3) could not do in-platform,
// for offsite3.mjs to apply to on the company's own careers site.
//   node build_offsite.mjs [scope=jr_jobs_target.json]
import fs from 'fs';
const scope = process.argv[2] || 'jr_jobs_target.json';
const lines = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const target = new Set(JSON.parse(fs.readFileSync(scope, 'utf8')).map(j => j.id));
const done = new Set(lines('offsite3.jsonl').filter(r => /^(SUBMITTED|ALREADY-APPLIED)$/.test(r.status)).map(r => r.id));
// skip-external-redirect / no-apply-button belong here too: offsite3 opens the
// job's applyLink directly, which is usually the employer's own ATS.
const OFFSITE = /^(offsite-deferred|skip-external-redirect|no-apply-button)$/;
const seen = new Set();
const batch = lines('applied3.jsonl').filter(r => OFFSITE.test(r.status) && target.has(r.id) && !done.has(r.id) && !seen.has(r.id) && seen.add(r.id))
  .map(r => ({ id: r.id, txt: r.title }));
fs.writeFileSync('offsite_batch.json', JSON.stringify(batch));
console.log(`${batch.length} jobs to apply to on company sites -> offsite_batch.json`);
