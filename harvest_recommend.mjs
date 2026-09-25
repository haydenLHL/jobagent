// Harvest job IDs directly from JobRight's own recommend feed (jobright.ai/jobs/recommend),
// instead of the intern-list.com minisite grid. Same scroll-container technique as
// harvest_ms.mjs: the list virtualizes inside index_jobs-page-main-content__qd__a,
// not the window, so both must be scrolled.
import { chromium } from 'playwright-core';
import fs from 'fs';
const MAX_ROUNDS = Number(process.env.ROUNDS || 120);
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const c = b.contexts()[0];
const out = new Map();
const p = await c.newPage();
await p.goto('https://jobright.ai/jobs/recommend', { waitUntil: 'domcontentloaded', timeout: 35000 });
await p.waitForTimeout(6000);
await p.evaluate(() => { const t = document.getElementById('___reactour'); if (t) t.remove(); });
let stale = 0, before = 0;
for (let r = 0; r < MAX_ROUNDS && stale < 6; r++) {
  const found = await p.evaluate(() => {
    const res = [];
    document.querySelectorAll('a[href*="jobs/info"]').forEach(a => {
      const m = (a.getAttribute('href') || '').match(/jobs\/info\/([0-9a-f]{24})/);
      if (!m) return;
      const row = a.closest('[class*=row],[role=row]') || a.parentElement?.parentElement;
      res.push({ id: m[1], txt: ((row?.innerText) || a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160) });
    });
    return res;
  }).catch(() => []);
  found.forEach(f => { if (!out.has(f.id) || out.get(f.id).length < f.txt.length) out.set(f.id, f.txt); });
  stale = out.size === before ? stale + 1 : 0;
  before = out.size;
  await p.evaluate(() => {
    const t = document.getElementById('___reactour'); if (t) t.remove();
    window.scrollBy(0, 4000);
    [...document.querySelectorAll('div')].filter(e => e.scrollHeight > e.clientHeight + 100 && e.clientHeight > 250)
      .forEach(e => { e.scrollTop += 4000; });
  });
  await p.waitForTimeout(1500);
  if (r % 10 === 0) console.log(`round ${r}: ${out.size} unique so far`);
}
await p.close();
const arr = [...out.entries()].map(([id, txt]) => ({ id, txt }));
fs.writeFileSync('jr_jobs.json', JSON.stringify(arr, null, 1));
console.log(`TOTAL harvested from jobright.ai/jobs/recommend: ${arr.length}`);
arr.slice(0, 5).forEach((j, i) => console.log(` ${i + 1}. ${j.id} ${j.txt.slice(0, 80)}`));
await b.close();
