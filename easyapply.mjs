// EASY-APPLY-first bulk runner.
// Run:  cd ~/.jobagent && SUBMIT=1 node easyapply.mjs
//       SUBMIT=0 for a dry run (fills everything, never clicks Submit)
//       LIMIT=5 to try a small batch first  <-- RECOMMENDED FIRST RUN
import { chromium } from 'playwright-core';
import fs from 'fs';

const SUBMIT = process.env.SUBMIT === '1';
const LIMIT = Number(process.env.LIMIT || 9999);
const OUT = 'easyapply.jsonl';

// Prefer jobs already classified as EASY-APPLY; fall back to the full list.
let queue = [];
if (fs.existsSync('classify.jsonl')) {
  queue = fs.readFileSync('classify.jsonl', 'utf8').trim().split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(r => r.path === 'EASY-APPLY');
}
if (!queue.length) queue = JSON.parse(fs.readFileSync('jobs.json', 'utf8'));
queue = queue.slice(0, LIMIT);

const done = fs.existsSync(OUT)
  ? new Set(fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).id))
  : new Set();

const withTimeout = (pr, ms) =>
  Promise.race([pr, new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), ms))]);

// User directive: for questions not in the bank, answer the way the question is
// fishing for. NEVER for work authorization - a false "authorized without
// sponsorship" fails at I-9 and is a misrepresentation on record.
// User directive: answer these for every job.
// Work authorization -> NO. User's explicit choice and it is the truthful answer:
// they require J-1 sponsorship and are not authorized without it.
// CAREFUL - opposite polarity on the same topic:
//   "are you authorized to work?"        -> NO  (needs J-1)
//   "will you require sponsorship?"      -> YES (does require it)
// SPONSOR must be tested FIRST; its text contains "work authorization".
const SPONSOR = /requir\w*\s+(company\s+)?sponsor|need\s+sponsor|sponsorship for a visa|require .{0,30}(visa|work authorization)|now or in the future require/i;
const WORK_AUTH = /legally authoriz|authoriz(ed|ation) to work|eligible to work|legal right to work|right to work|work permit/i;

const YES = /relocat|on-?site|in[- ]office|in[- ]person|i understand|willing|able to|commute|hybrid|travel|18 years|older|agree|consent|acknowledg|confirm|terms|privacy|background check|reference check|identity[- ]verification|drug (test|screen)|comfortable with (that|this) range|pays \$|hourly rate|be considered for other|proficient with|proficien(t|cy)|housing arrangements/i;

const NO = /convict|criminal|felony|misdemeanor|non-?compete|restrictive covenant|relative|family member|related to (an|any) employee|previously (work|employ)|currently employed by|own, operate|other business|outside (employment|business)|conflict of interest|any offers|outstanding offers|deadlines? (we should|to accept)|other firms|fall career fair|career fair|sponsors for educational opportunity|\bSEO\b program|completed an application for any other/i;

// Preference picks where no factual claim is made. Logged as inferred.
const PREF = [
  [/which location|Houston and NYC|location can you/i, /new york|nyc/i],
  [/Research or Operations/i, /research/i],
  [/one role\/location at a time/i, /^yes/i],
];

function infer(q, opts) {
  const find = re => opts.find(o => re.test(o));
  if (SPONSOR.test(q)) return find(/^yes/i) || null;    // truthful: DOES require sponsorship
  if (WORK_AUTH.test(q)) return find(/^no/i) || null;   // truthful: not authorized without it
  for (const [qre, ore] of PREF) if (qre.test(q)) { const m = find(ore); if (m) return m; }
  // province/state for a Toronto-based applicant
  if (/^\*?(state|province)/i.test(q)) return find(/ontario/i) || null;
  if (/country/i.test(q)) return find(/canada/i) || null;
  if (YES.test(q)) return find(/^yes/i) || null;
  if (NO.test(q)) return find(/^no/i) || null;
  return null;                                          // still unknown -> abort
}

// Ant Design aware: a select's value lives in .ant-select-selection-item, NOT input.value.
const gapScan = page => page.evaluate(() => {
  const m = document.querySelector('.ant-modal,[role=dialog]');
  if (!m) return null;
  const fields = [...m.querySelectorAll('[class*=gh-autofill-popup-field]')];
  const gaps = [];
  let filled = 0;
  for (const f of fields) {
    const txt = (f.innerText || '').replace(/\s+/g, ' ').trim();
    const req = /\*/.test(txt);
    const sel = f.querySelector('.ant-select');
    if (sel) {
      if (sel.querySelector('.ant-select-selection-item')) filled++;
      else gaps.push({ kind: 'select', req, txt: txt.slice(0, 90) });
      continue;
    }
    const inp = f.querySelector('input,textarea');
    if (!inp) continue;
    const ty = (inp.type || '').toLowerCase();
    if (ty === 'checkbox' || ty === 'radio') { if (inp.checked) filled++; continue; }
    if (String(inp.value || '').trim()) filled++;
    else gaps.push({ kind: 'input', req, txt: txt.slice(0, 90) });
  }
  return {
    total: fields.length, filled, gaps,
    reqGaps: gaps.filter(g => g.req),
    captcha: !!document.querySelector('iframe[src*=recaptcha],iframe[src*=hcaptcha]'),
  };
});

const b = await chromium.connectOverCDP('http://localhost:9222');
const c = b.contexts()[0];
let submitted = 0, n = 0;

for (const j of queue) {
  n++;
  if (done.has(j.id)) continue;
  const rec = { id: j.id, title: (j.company || j.title || '').slice(0, 60) };
  let p = null;
  try {
    await withTimeout((async () => {
      p = await c.newPage();
      await p.goto(`https://jobright.ai/jobs/info/${j.id}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await p.waitForTimeout(3200);
      await p.evaluate(() => { const t = document.getElementById('___reactour'); if (t) t.remove(); });

      const easy = p.locator('button:has-text("EASY APPLY")').first();
      if (!await easy.count()) { rec.status = 'no-easy-apply'; return; }
      // MUST be a trusted click - el.click() is ignored by the extension/app
      await easy.click({ timeout: 10000 }).catch(() => {});
      await p.waitForTimeout(4000);

      // Detect an already-submitted job BEFORE any fill/refusal logic, or it gets
      // mislabelled 'too-sparse-refused' (the success screen has no form fields).
      const pre = await p.evaluate(() => {
        const m = document.querySelector('.ant-modal,[role=dialog]');
        return !!m && /Application submitted!|has been marked as Applied/i.test(m.innerText || '');
      }).catch(() => false);
      if (pre) { rec.status = 'ALREADY-APPLIED'; return; }

      const start = p.locator('button:has-text("Start to Autofill")').first();
      if (await start.count()) {
        await start.click({ timeout: 10000 }).catch(() => {});
        let prev = -1;
        for (let k = 0; k < 5; k++) {
          await p.waitForTimeout(3000);
          const s = await gapScan(p);
          if (!s) break;
          if (s.filled === prev) break;
          prev = s.filled;
        }
      } else rec.note = 'no-start-autofill';

      let s = await gapScan(p);
      if (!s) { rec.status = 'no-modal'; return; }
      rec.total = s.total; rec.filled = s.filled;

      if (s.captcha) { rec.status = 'skip-captcha'; return; }

      // Resolve required gaps. Single-option selects are acknowledgements ("Thank you")
      // and are safe to auto-pick. Multi-option gaps are attested -> abort, never guess.
      // Resolve one gap at a time, re-scanning each pass. The question text is read
      // from the SAME element we open, so an answer can never land on another field.
      for (let pass = 0; pass < 12; pass++) {
        const g = await p.evaluate(() => {
          const m = document.querySelector('.ant-modal,[role=dialog]');
          for (const f of m.querySelectorAll('[class*=gh-autofill-popup-field]')) {
            const sel = f.querySelector('.ant-select');
            if (sel && !sel.querySelector('.ant-select-selection-item')) {
              const txt = (f.innerText || '').replace(/\s+/g, ' ').trim();
              if (!/\*/.test(txt)) continue;          // only required gaps block us
              sel.querySelector('.ant-select-selector')
                ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              return { txt: txt.slice(0, 120), kind: 'select' };
            }
          }
          return null;
        });
        if (!g) break;                                 // no required select gaps left
        const opened = true;
        if (!opened) continue;
        await p.waitForTimeout(1400);
        const opts = await p.evaluate(() =>
          [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content')]
            .map(e => (e.innerText || '').trim()));
        let choice = null;
        if (opts.length === 1) {
          choice = opts[0];                       // single option = acknowledgement
        } else {
          choice = infer(g.txt, opts);            // user directive: answer agreeably
        }
        if (choice) {
          const opt = p.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content')
            .filter({ hasText: new RegExp(`^${choice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first();
          const target = await opt.count() ? opt
            : p.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content').first();
          await target.click({ timeout: 5000 }).catch(() => {});
          (rec.inferred ||= []).push(`${g.txt.slice(0, 40)} -> ${choice}`);
        } else {
          rec.status = 'needs-judgment';
          rec.unresolved = { q: g.txt, options: opts.slice(0, 8) };
          await p.keyboard.press('Escape').catch(() => {});
          return;
        }
        await p.waitForTimeout(1200);
      }

      s = await gapScan(p);
      rec.filled = s.filled;
      if (s.reqGaps.length) {
        rec.status = 'blocked-required';
        rec.unresolved = s.reqGaps.slice(0, 3).map(g => g.txt);
        return;
      }
      // sanity floor: never submit a near-empty application
      if (s.filled < 10) { rec.status = 'too-sparse-refused'; return; }

      if (!SUBMIT) { rec.status = 'READY'; return; }

      // If a previous run already submitted this, the modal opens on the success screen.
      const already = await p.evaluate(() => {
        const m = document.querySelector('.ant-modal,[role=dialog]');
        return !!m && /Application submitted!/i.test(m.innerText || '');
      }).catch(() => false);
      if (already) { rec.status = 'ALREADY-APPLIED'; return; }

      const sb = p.locator('.ant-modal button, [role=dialog] button').filter({ hasText: /^Submit$/ }).first();
      if (!await sb.count()) { rec.status = 'no-submit-btn'; return; }
      await sb.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      if (!await sb.isEnabled().catch(() => false)) { rec.status = 'submit-disabled'; return; }
      await sb.click({ timeout: 12000 }).catch(() => {});

      // Confirmation MUST be JobRight's own success text, scoped to the MODAL.
      // Matching document.body false-positives on the nav's "Applied 1621" counter.
      let ok = false;
      for (let k = 0; k < 10; k++) {
        await p.waitForTimeout(3000);
        ok = await p.evaluate(() => {
          const m = document.querySelector('.ant-modal,[role=dialog]');
          if (!m) return false;
          return /Application submitted!|has been marked as Applied/i.test(m.innerText || '');
        }).catch(() => false);
        if (ok) break;
      }

      if (!ok) {
        rec.status = 'submit-unconfirmed';
        rec.modalTail = await p.evaluate(() => {
          const m = document.querySelector('.ant-modal,[role=dialog]');
          return m ? (m.innerText || '').replace(/\s+/g, ' ').slice(-160) : null;
        }).catch(() => null);
        return;
      }
      // JobRight marks it Applied itself on this path - no "Yes, I applied" click needed.
      rec.status = 'SUBMITTED'; rec.marked = 1; submitted++;
      const dn = p.locator('.ant-modal button, [role=dialog] button').filter({ hasText: /^Done$/ }).first();
      if (await dn.count()) await dn.click({ timeout: 5000 }).catch(() => {});
    })(), 110000);
  } catch (e) {
    rec.status = 'err:' + String(e.message).slice(0, 40);
  }
  try { if (p && !p.isClosed()) await p.close(); } catch {}
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
  console.log(`[${n}/${queue.length}] ${String(rec.status).padEnd(20)} ${rec.filled ?? '-'}/${rec.total ?? '-'} ${rec.marked ? 'MARKED ' : ''}${rec.title.slice(0, 40)}`);
}

console.log(`\ndone. processed=${n} submitted=${submitted}`);
await b.close();
