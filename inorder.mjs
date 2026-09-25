// Single-pass driver: works the queue IN ORDER, one job at a time. Each job
// gets EASY APPLY (apply3) first; if that defers it offsite, the same job goes
// straight to APPLY WITH AUTOFILL (offsite3) before moving on. The two scripts
// never run concurrently (they share one Chrome - see gotchas).
// Resumable: a job already settled in the ledgers is skipped; one deferred by
// apply3 but never tried offsite resumes at the offsite step.
// Usage: QUEUE_FILE=fresh.json [SUBMIT=1] node inorder.mjs
import fs from 'fs';
import { spawnSync } from 'child_process';

const NODE = `${process.env.HOME}/.local/share/mise/shims/node`;
const QUEUE = JSON.parse(fs.readFileSync(process.env.QUEUE_FILE || 'fresh.json', 'utf8'));
const OFFSITE = /^(offsite-deferred|skip-external-redirect|no-apply-button)$/;
const ONE = '_inorder_one.json';
const rd = f => fs.existsSync(f)
  ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
const last = (f, id) => rd(f).filter(r => r.id === id).pop();

async function tidyTabs() {
  try {
    const list = await (await fetch('http://localhost:9222/json/list')).json();
    const pages = list.filter(t => t.type === 'page');
    for (const t of pages) if (!/jobs\/recommend/.test(t.url)) await fetch(`http://localhost:9222/json/close/${t.id}`).catch(() => {});
    // zero open tabs breaks connectOverCDP
    await fetch('http://localhost:9222/json/new?about:blank', { method: 'PUT' }).catch(() => {});
  } catch {}
}

function run(script, env, log) {
  const r = spawnSync(NODE, [script], {
    env: { ...process.env, QUEUE_FILE: ONE, ...env },
    encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 64 << 20,
  });
  fs.appendFileSync(log, (r.stdout || '') + (r.stderr || ''));
  return r;
}

let n = 0, sub = 0;
for (const job of QUEUE) {
  n++;
  const off = last('offsite3.jsonl', job.id);
  let a = last('applied3.jsonl', job.id);
  if (off || (a && !OFFSITE.test(a.status))) continue;
  fs.writeFileSync(ONE, JSON.stringify([job]));
  await tidyTabs();
  if (!a) {
    run('apply3.mjs', { JOB_TIMEOUT: process.env.A_TIMEOUT || '720000' }, 'inorder_apply3.log');
    a = last('applied3.jsonl', job.id);
  }
  let st = `easy:${a?.status || 'none'}`;
  if (a?.status === 'SUBMITTED') sub++;
  if (a && OFFSITE.test(a.status)) {
    await tidyTabs();
    run('offsite3.mjs', { ONLY: job.id, JOB_TIMEOUT: process.env.O_TIMEOUT || '600000' }, 'inorder_offsite3.log');
    const o = last('offsite3.jsonl', job.id);
    st += ` -> auto:${o?.status || 'none'}${o?.filled != null ? ` ${o.filled}/${o.total}` : ''}`;
    if (o?.status === 'SUBMITTED') sub++;
  }
  const line = `${new Date().toISOString().slice(11, 19)} [${n}/${QUEUE.length}] ${st} | ${(job.txt || '').replace(/\s+/g, ' ').slice(0, 70)}`;
  console.log(line);
}
console.log(`processed=${n} submitted=${sub}`);
