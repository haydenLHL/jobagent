// apply3 - intern-list/minisite pipeline.
//   source: ms_jobs.json (harvested from jobright.ai/minisites-jobs/intern/us/*)
//   per job: open /jobs/info/<id> -> EASY APPLY (in-platform) or APPLY WITH AUTOFILL (offsite)
//            -> autofill -> resolve gaps -> submit -> mark applied
//   login/password wall  -> skip
//   unresolved gaps      -> logged to gaps.jsonl for subagent inference, job left un-submitted
//
// Hard-won details this relies on (do not "simplify" these):
//   * EASY APPLY / Autofill need a TRUSTED click; el.click() from page JS is ignored.
//   * Gap fields live in [class*=gh-autofill-popup-field].
//   * Ant Design selects store their value in .ant-select-selection-item, NOT input.value.
//   * Confirmation MUST be read from the MODAL ("Application submitted!"), never
//     document.body - the nav contains "Applied 1671" and false-positives everything.
//   * A single-option select is an acknowledgement dropdown and is safe to auto-pick.
//   * reCAPTCHA v3 is invisible and harmless; only a VISIBLE v2 widget blocks.
import { chromium } from 'playwright-core';
import fs from 'fs';
import { askLLM, norm as lnorm } from './llm.mjs';
import { cleanTitle } from './title.mjs';
import { FACTS, EDU_START_YEAR, doc as docPath } from './profile.mjs';

const SUBMIT = process.env.SUBMIT === '1';
const LIMIT = Number(process.env.LIMIT || 9999);
const LEDGER = 'applied3.jsonl';
const GAPS = 'gaps.jsonl';

const jobs = JSON.parse(fs.readFileSync(process.env.QUEUE_FILE || 'ms_jobs.json', 'utf8')).slice(0, LIMIT);
// Same fix as offsite3: a non-terminal outcome is OUR failure, not the job's,
// and must not write the job off forever. 'offsite-deferred' IS terminal here
// - offsite3.mjs owns those from then on.
const TERMINAL = /^(SUBMITTED|ALREADY-APPLIED|skip-listed|offsite-deferred)$/;
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
const RUN_ID = new Date().toISOString().slice(0, 16);
const priorRecs = fs.existsSync(LEDGER)
  ? fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
// Cross-ledger dedupe - see the matching comment in offsite3.mjs. If the
// autofill pass already submitted this job, EASY APPLY must not submit it again.
const otherDone = new Set();
if (fs.existsSync('offsite3.jsonl')) {
  for (const l of fs.readFileSync('offsite3.jsonl', 'utf8').trim().split('\n')) {
    if (!l) continue;
    try { const r = JSON.parse(l); if (/^(SUBMITTED|ALREADY-APPLIED)$/.test(String(r.status))) otherDone.add(r.id); } catch {}
  }
}
const terminalIds = new Set(otherDone), attemptCount = new Map();
for (const r of priorRecs) {
  if (TERMINAL.test(String(r.status))) terminalIds.add(r.id);
  else if (!/^err:|^scan-failed$|^READY$/.test(String(r.status))) attemptCount.set(r.id, (attemptCount.get(r.id) || 0) + 1);
}
const done = { has: id => terminalIds.has(id) || (attemptCount.get(id) || 0) >= MAX_ATTEMPTS };
const LLM_ON = process.env.LLM !== '0';
const LLM_ANS = new Map();

// answers learned from subagent inference get merged in here
const LEARNED = fs.existsSync('learned.json') ? JSON.parse(fs.readFileSync('learned.json', 'utf8')) : {};

const ATS_SKIP = fs.existsSync('ats_skip.txt')
  ? fs.readFileSync('ats_skip.txt', 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean)
  : [];
const skipListed = t => ATS_SKIP.some(h => String(t || '').toLowerCase().includes(h));

const SPONSOR = /requir\w*\s+(company\s+)?sponsor|need\s+sponsor|sponsorship for a visa|require .{0,30}(visa|work authorization)|now or in the future require/i;
const WORK_AUTH = /legally authoriz|authoriz(ed|ation) to work|eligible to work|legal right to work|right to work|work permit/i;
const EEO = /gender|race|ethnicity|hispanic|latino|veteran|disabilit|self-?identif/i;
const YES = /relocat|on-?site|in[- ]office|in[- ]person|i understand|willing|able to|commute|hybrid|travel|18 years|older|agree|consent|acknowledg|confirm|terms|privacy|background check|reference check|identity[- ]verification|drug (test|screen)|comfortable with|pays \$|hourly rate|be considered for other|proficient/i;
const NO = /convict|criminal|felony|misdemeanor|non-?compete|restrictive covenant|relative|family member|related to (an?|any) (\w+ ){0,3}employee|previously (work|employ)|currently employed by|own, operate|other business|outside (employment|business)|conflict of interest|any offers|outstanding offers|deadlines? (we should|to accept)|other firms|career fair|sponsors for educational opportunity/i;
const DECLINE = /decline|choose not|prefer not|do not wish|don'?t wish|not disclose|not to self/i;

// Exact-equality option matching made learned.json nearly inert ("Personal
// Mobile" never equals the option "Mobile"). Same fix as offsite3.
const nkey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function fuzzyOpt(opts, want) {
  if (!want) return null;
  const w = nkey(want); if (!w) return null;
  const cand = opts.filter(o => nkey(o));
  return cand.find(o => nkey(o) === w)
      || cand.find(o => nkey(o).split(' ').includes(w))
      || cand.find(o => w.split(' ').includes(nkey(o)))
      // Whole-word containment only: raw substring picked "AR" for Ontario
      // on a US-state list (offsite3, 2026-09-24).
      || cand.find(o => { const k = nkey(o); const wb = (a, b) => new RegExp(`(^| )${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(a); return wb(k, w) || wb(w, k); })
      || null;
}
const learnedFreeText = (q, v) => {
  const bare = /^(yes|no)$/i.test(String(v).trim());
  const head = String(q).replace(/^[\s*\u2731\u200b]+/, "");
  if (bare && /^(what|which|how|when|where|who|why)\b/i.test(head)) return null;
  return (/\?/.test(q) || !bare) ? v : null;
};
function infer(q, opts) {
  const find = re => opts.find(o => re.test(o));
  const llm = LLM_ANS.get(lnorm(q));
  if (llm) { const m = fuzzyOpt(opts, llm); if (m) return m; if (!opts.length) return llm; }
  // learned answers from subagent inference take priority
  for (const [k, v] of Object.entries(LEARNED)) {
    // A learned answer used to be returned ONLY via fuzzyOpt, which needs a
    // matching OPTION - so learned.json could never answer a free-text
    // question. The LLM branch directly above always had this fallback; the
    // learned branch silently did not, and free-text was the single biggest
    // needs-inference bucket ("Do you have a Duolingo account?" x6 etc).
    if (q.toLowerCase().includes(k.toLowerCase())) { const m = fuzzyOpt(opts, v); if (m) return m; if (!opts.length) { const fv = learnedFreeText(q, v); if (fv) return fv; } }
  }
  // Prior employment with THIS employer ("Have you ever worked for MITRE?").
  // Derived, not guessed: Yes only if the question names a work_history
  // employer (IBM, Wealthsimple, Qoherent), else No. A blanket learned "No"
  // would lie on an IBM form. Generic objects ("a government contractor",
  // "any federal agency") and relatives are NOT this question - leave those.
  if (opts.length && find(/^\s*yes\b/i) && find(/^\s*no\b/i)
      && (/\b(have|had) you\b.{0,25}\b(worked|been employed|interned|been an? (employee|intern|contractor))\b.{0,12}\b(for|by|at|with)\b/i.test(q) || /\bare you an? (former|previous|past) (employee|intern)\b/i.test(q))
      && !/relative|family|spouse|friend|(government|federal|defense) (contractor|agency|entity)|government|\b(for|by|at|with) (a|an|any)\b/i.test(q)) {
    const emps = (FACTS?.work_history || []).map(w => w.employer).filter(Boolean);
    const named = emps.some(e => new RegExp(`\\b${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(q));
    return find(named ? /^\s*yes\b/i : /^\s*no\b/i);
  }
  // "Were you referred to <Company> by a current employee?" - no referral in
  // FACTS (referral source is LinkedIn); learned.json already says No for the
  // "referred to this role" wording, but a company name in the middle broke
  // the substring match (RII on Lever, 2026-09-24).
  if (opts.length && find(/^\s*no\b/i) && /\b(were|are|have) you (been )?referred\b|\breferred .{0,40}\bby (a|an) (current )?(employee|team member|staff)/i.test(q)
      && !/\bhow\b|\bwhere\b|source/i.test(q)) return find(/^\s*no\b/i);
  // Conditional follow-up to a negative answer -> N/A by construction.
  if (!opts.length && /^[\s*\u2731\u200b]*(\(?[a-z0-9]{1,3}[.)]\s*)?if\s+((you\s+(answered|selected|indicated|responded|checked)\b)|(referred\s+by\b)|((the\s+answer\s+is\s+)?['"\u201c]?(yes|no)\b)|(so|other|any|applicable|selected)\b)/i.test(q)) return "N/A";
  // Class standing is DERIVED, not stored: answers.json has education
  // start_year 2024, so in the fall of year Y the standing is (Y - 2024 + 1).
  // A static learned.json answer would be right for "summer 2027" (Senior)
  // and wrong for any posting naming a different year, so only answer when
  // the question itself states the year.
  {
    const CLASS_OPT = /freshman|sophomore|junior|senior|graduate student/i;
    if (opts.length && opts.filter(o => CLASS_OPT.test(o)).length >= 2) {
      const ym = String(q).match(/\b(20\d{2})\b/);
      if (ym && EDU_START_YEAR) {
        const nth = Number(ym[1]) - EDU_START_YEAR + 1;
        const want = nth <= 1 ? "Freshman" : nth === 2 ? "Sophomore" : nth === 3 ? "Junior" : nth === 4 ? "Senior" : "Graduate Student";
        const hit = fuzzyOpt(opts, want);
        if (hit) return hit;
      }
    }
  }
  // Internship date-window preference ("May 24, 2027 - August 20, 2027",
  // "June 7, 2027 - September 3, 2027", "None of these dates work for me").
  // Every concrete window is truthful - answers.json start_date_summer is
  // 2027-05-01 with relocate:true and no stated constraint - so take the
  // first real one and never the opt-out, which would withdraw the
  // application. Bare year lists (graduation) have no month+day and so
  // cannot match this.
  {
    const DATEOPT = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s*20\d{2}/i;
    const dated = opts.filter(o => DATEOPT.test(o));
    if (dated.length >= 2) {
      const real = dated.find(o => !/none of these|not available|neither|does not work|other/i.test(o));
      if (real) return real;
    }
  }
  // "What is your top location preference?" / "Which office are you applying
  // to?" - the bank answer is prose ("Open to any of your US office
  // locations"), which can never fuzzy-match a list of cities, so every one
  // of these gapped. answers.json has preferred_locations "Anywhere" and
  // relocate:true, so any offered office is truthful: take the first real one.
  // An acknowledgement of a STATED FACT ABOUT THE ROLE ("This internship is
  // based in New York, NY and requires in-person presence. Please confirm your
  // understanding") is agreeable - it matches learned.json's own
  // "requires in-person" / "based in new york" answers, and a Yes/No learned
  // value can never fuzzy-match ["I confirm","I do not confirm"].
  // It is NOT agreeable when the sentence asserts something about the
  // CANDIDATE's credentials or status: "This role requires a security
  // clearance. Please confirm you hold one." Those topics are never_infer.
  const CONFIRM_NEVER = /clearance|citizen|work authoriz|authoriz(ed|ation) to work|sponsor|visa|degree|diploma|licen[cs]e|certifi|years? of experience|gpa|transcript|felony|conviction|background check history|polygraph/i;
  if (opts.length && !CONFIRM_NEVER.test(q)
      && /^\s*[*\u2731]?\s*(this|the)\b.{0,200}\b(confirm|acknowledge|understand)/i.test(q)) {
    const aff = opts.find(o => /^i (confirm|acknowledge|understand|agree)/i.test(String(o).trim()))
             || opts.find(o => /^(yes|i do)\b/i.test(String(o).trim()));
    const neg = opts.find(o => /\b(do not|don't|cannot|can't)\b/i.test(String(o)));
    if (aff && aff !== neg) return aff;
  }
  if (opts.length && /location preference|preferred location|preferred office|top location|which office|office (would you |you would )?prefer|location.{0,12}prefer|metro area|which (of the listed )?(metro|office|location)s? (are|do) you/i.test(q)) {
    const real = opts.find(o => o && !/^\d+$/.test(o) && !/^(select|choose|please select|--|none|other)/i.test(o.trim()));
    if (real) return real;
  }
  // A required State/Province select whose list is US-only cannot be answered
  // for an Ontario address - and now that readAllOpts sees the WHOLE list
  // (fix 41) instead of the first nine, we can tell the difference between
  // "not found yet" and "genuinely not offered". If the form provides an
  // explicit escape hatch, that is the truthful answer; otherwise still gap.
  if (opts.length >= 10 && /\b(state|province)\b/i.test(q)) {
    const mine = opts.find(o => /^(ontario|on)$/i.test(String(o).trim()));
    if (mine) return mine;
    const escape = opts.find(o => /^(outside (the )?(us|u\.s\.|united states)|non-?us|not applicable|n\/a|other)$/i.test(String(o).trim()));
    if (escape) return escape;
  }
  // "How did you hear about us?" is one of the most common required questions
  // on every ATS, and learned.json answers it "LinkedIn" - but plenty of forms
  // do not OFFER LinkedIn (Excellus: ["Agency","College Campus/High School
  // Campaign",...]), so fuzzyOpt failed and a 14/16 form died on this one
  // field. Fall back down a chain that stays TRUTHFUL: the posting really was
  // found on an online job board (JobRight), so a job-board/internet option is
  // accurate; "Other" only as a last resort. Never pick Agency/Referral/Career
  // Fair - those would be false.
  if (opts.length && /how did you (hear|find out|learn) about|referral source|source of (application|referral)/i.test(q)) {
    const pick = re => opts.find(o => re.test(o));
    const hit = pick(/linkedin/i)
             || pick(/job\s*board|online|internet|job\s*(search|posting)\s*site|indeed|glassdoor/i)
             || pick(/company (web)?site|career site|web\s*site|website/i)
             || pick(/^\s*other\b/i);
    if (hit) return hit;
  }
  if (SPONSOR.test(q)) {
    const yes = find(/^yes/i);
    if (yes) return yes;
    // Ashby-style visa lists have no plain "Yes" - e.g. ["I am authorized to
    // work in the US without sponsorship", "I am on an H-1B and need a
    // transfer", "I need H-1B sponsorship (new application / lottery)",
    // "Other"]. find(/^yes/) matched nothing, so a required question we know
    // the answer to gapped. Take a GENERIC "need sponsorship" option, but
    // never one naming a visa class we do not need: as a student the answer
    // is J-1/F-1, and claiming H-1B would be false.
    const generic = opts.find(o => /(need|require).{0,20}sponsorship/i.test(o) && !/h-?1b|h1-?b|\btn\b|o-?1|l-?1/i.test(o));
    if (generic) return generic;
    return find(/^other\b/i) || null;
  }     // truthful: needs J-1
  if (WORK_AUTH.test(q)) return find(/^no/i) || null;    // truthful: not without sponsorship
  if (EEO.test(q)) return find(DECLINE) || null;
  if (/country/i.test(q)) return find(/canada/i) || null;
  if (/state|province/i.test(q)) return find(/ontario/i) || null;
  if (YES.test(q)) return find(/^yes/i) || null;
  if (NO.test(q)) return find(/^no/i) || null;
  return null;
}

// --- in-modal gap scan (Ant-aware) ---
const gapScan = pg => pg.evaluate(() => {
  const m = document.querySelector('.ant-modal,[role=dialog]');
  if (!m) return null;
  const fields = [...m.querySelectorAll('[class*=gh-autofill-popup-field]')];
  const gaps = []; let filled = 0;
  for (const f of fields) {
    const txt = (f.innerText || '').replace(/\s+/g, ' ').trim();
    const req = /\*/.test(txt);
    const sel = f.querySelector('.ant-select');
    if (sel) {
      if (sel.querySelector('.ant-select-selection-item')) filled++;
      else gaps.push({ kind: 'select', req, txt: txt.slice(0, 160) });
      continue;
    }
    // Check the FILE input explicitly and first. An upload field renders a
    // text input for the filename display ahead of the real input[type=file],
    // so querySelector('input,textarea') picked the text one, ty was never
    // 'file', and an attached transcript still read as an unresolved required
    // gap (confirmed: the field text said "transcript.pdf" while gapScan
    // reported it empty).
    const fileInp = f.querySelector('input[type=file]');
    if (fileInp) {
      if (fileInp.files && fileInp.files.length) filled++;
      else gaps.push({ kind: 'file', req, txt: txt.slice(0, 160) });
      continue;
    }
    const inp = f.querySelector('input,textarea');
    if (!inp) continue;
    const ty = (inp.type || '').toLowerCase();
    if (ty === 'checkbox' || ty === 'radio') { if (inp.checked) filled++; continue; }
    // A file input's .value is always '' even with a file attached, so an
    // uploaded transcript counted as an unresolved required gap and killed
    // the submission ("*Please upload a copy of your most up-to-date college
    // transcripts" on two Duolingo roles, both otherwise 34/37 complete).
    if (ty === 'file') { if (inp.files && inp.files.length) filled++; else gaps.push({ kind: 'file', req, txt: txt.slice(0, 160) }); continue; }
    if (String(inp.value || '').trim()) filled++;
    else gaps.push({ kind: 'input', req, txt: txt.slice(0, 160) });
  }
  const big = e => e.offsetWidth > 10 && e.offsetHeight > 10;
  const captcha = [...document.querySelectorAll('iframe')].some(f => /recaptcha.*api2\/anchor|recaptcha.*bframe|hcaptcha/i.test(f.src || '') && big(f))
    || [...document.querySelectorAll('.g-recaptcha,[data-sitekey]')].some(big);
  return { total: fields.length, filled, gaps, reqGaps: gaps.filter(g => g.req), captcha,
           submitted: /Application submitted!|has been marked as Applied/i.test(m.innerText || '') };
});

// A JavaScript dialog with no listener registered lets playwright-core
// auto-handle it internally, and that internal path throws from inside its own
// event listener (DialogManager.dialogDidOpen) on a tick no try/catch of ours
// can see. offsite3 has guarded this for a while; apply3 never did, and it
// killed a 403-job run at job 60 with
// "Protocol error (Page.handleJavaScriptDialog): No dialog is showing".
const BENIGN_ASYNC = /No dialog is showing|Target (page|closed)|Session closed|Target page, context or browser has been closed/i;
process.on('unhandledRejection', (err) => {
  const msg = (err && (err.stack || err.message)) || String(err);
  if (BENIGN_ASYNC.test(msg)) { console.error('RECOVERED async rejection:', String(msg).split('\n')[0]); return; }
  console.error('UNHANDLED REJECTION:', msg);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  const msg = (err && (err.stack || err.message)) || String(err);
  if (BENIGN_ASYNC.test(msg)) { console.error('RECOVERED uncaught:', String(msg).split('\n')[0]); return; }
  console.error('UNCAUGHT EXCEPTION:', msg);
  process.exit(1);
});
let b = await chromium.connectOverCDP('http://localhost:9222');
let c = b.contexts()[0];
// Intercept dialogs ourselves so playwright-core never takes its throwing path.
const armDialogHandler = ctx => ctx.on('page', pg => pg.on('dialog', d => d.dismiss().catch(() => {})));
armDialogHandler(c);
// Ported from offsite3, which has had this for a while: one bad job can kill
// the whole CDP connection, after which EVERY later c.newPage() fails and the
// rest of the run is silently lost at a full timeout each. apply3 had no such
// protection at all.
const DEAD_BROWSER = /target page, context or browser has been closed|browser has been closed|connection closed|websocket.{0,20}closed/i;
let deadStreak = 0;
async function reconnect() {
  try { await b.close(); } catch {}
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      b = await chromium.connectOverCDP('http://localhost:9222');
      c = b.contexts()[0];
      armDialogHandler(c);
      await c.newPage().then(pg => pg.close());   // prove the fresh connection works
      return true;
    } catch { await new Promise(r => setTimeout(r, 3000)); }
  }
  return false;
}
const JOB_TIMEOUT = Number(process.env.JOB_TIMEOUT || 120000);
const withTimeout = (pr, ms) => Promise.race([pr, new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), ms))]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0, sub = 0;

for (const j of jobs) {
  n++;
  if (done.has(j.id)) continue;
  // ts/run: ledgers are append-only and had no timestamps, so a rate could
  // not be scoped to one run without guessing from record order.
  const rec = { id: j.id, title: cleanTitle(j.txt).slice(0, 70), ts: new Date().toISOString(), run: RUN_ID };
  if (skipListed(j.txt)) {
    rec.status = 'skip-listed';
    fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
    console.log(`[${n}] ${'skip-listed'.padEnd(20)} -/- ${rec.title.slice(0, 44)}`);
    continue;
  }
  LLM_ANS.clear();
  let p = null, ext = null;
  try {
    await withTimeout((async () => {
      p = await c.newPage();
      await p.goto(`https://jobright.ai/jobs/info/${j.id}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await p.waitForTimeout(3500);
      await p.evaluate(() => { const t = document.getElementById('___reactour'); if (t) t.remove(); });

      const easy = p.locator('button:has-text("EASY APPLY")').first();
      const auto = p.locator('button:has-text("APPLY WITH AUTOFILL")').first();
      const external = p.locator('button:has-text("APPLY NOW")').first();

      if (await easy.count().catch(() => 0)) {
        rec.path = 'easy';
        await easy.click({ timeout: 10000 }).catch(() => {});      // MUST be trusted
        await p.waitForTimeout(4000);
        // JobRight shows "Preparing Your Application... Loading the application
        // form." in the modal for several seconds before a single field exists.
        // The fixed 4s wait scanned straight through that, so a slow-loading
        // form scored 0/0 and was refused as too-sparse-refused - a RACE, not a
        // sparse form. (Found by the rec.sparse diagnostic: modals=1, inputs=0,
        // head="...Loading the application form.") Wait for it to clear.
        for (let k = 0; k < 14; k++) {
          const st = await p.evaluate(() => {
            const m = [...document.querySelectorAll('.ant-modal, [role=dialog]')].filter(e => e.getClientRects().length);
            const top = m[m.length - 1];
            if (!top) return null;
            return {
              loading: /loading the application form|preparing your application/i.test(top.innerText || ''),
              inputs: top.querySelectorAll('input,select,textarea').length,
            };
          }).catch(() => null);
          if (!st) break;
          if (!st.loading && st.inputs > 0) break;
          await p.waitForTimeout(2500);
        }
        // The loading wait above can now return the instant the first input
        // exists - which is EARLIER than the old fixed 4s wait landed, and the
        // "Start to Autofill" button may not be mounted yet. Skipping it drops
        // the extension's whole prefill: Interstates went 18/21 -> 1/20 the
        // first time this ran. Give that button a short, bounded chance to
        // appear before moving on.
        for (let k = 0; k < 6; k++) {
          if (await p.locator('button:has-text("Start to Autofill")').first().count().catch(() => 0)) break;
          // .some() was satisfied by a SINGLE pre-filled field (email), so the
          // wait exited before the extension had run: Lyft came out 1/28.
          // Require a real prefill, not any one value.
          const nFilled = await p.evaluate(() => {
            const m = [...document.querySelectorAll('.ant-modal, [role=dialog]')].filter(e => e.getClientRects().length).pop();
            if (!m) return 99;   // modal gone - stop waiting
            return [...m.querySelectorAll('input,textarea')].filter(e => String(e.value || '').trim()).length;
          }).catch(() => 99);
          if (nFilled >= 3) break;
          await p.waitForTimeout(2000);
        }
        rec.phase = 'loaded';
        let s = await gapScan(p);
        if (s?.submitted) { rec.status = 'ALREADY-APPLIED'; return; }
        // The Start-to-Autofill button can mount LATER than the first field,
        // so a single check missed it and the extension prefill never ran:
        // HAI Group came out 1/20 even with the pre-scan wait. Re-look while
        // the form is still nearly empty, then let the fill settle.
        for (let a = 0; a < 5; a++) {
          const start = p.locator('button:has-text("Start to Autofill")').first();
          if (await start.count().catch(() => 0)) {
            await start.click({ timeout: 10000 }).catch(() => {});
            let prev = -1;
            for (let k = 0; k < 5; k++) { await p.waitForTimeout(3000); s = await gapScan(p); if (!s) break; if (s.total > 0 && s.filled === prev) break; prev = s.filled; }
            break;
          }
          // Only keep waiting while the form looks unfilled - a form the
          // extension already handled must not pay this cost.
          if (!s || s.filled >= 3 || !(s.total >= 5)) break;
          await p.waitForTimeout(3000);
          s = (await gapScan(p)) || s;
        }
        // Attach resume/transcript to any empty file input in the modal. The
        // gap loop below only ever knew how to open Ant selects, so an upload
        // field was a guaranteed dead end even though both files are on disk.
        const unresolvedDocs = [];
        for (const f of await p.locator('.ant-modal input[type=file], [role=dialog] input[type=file]').all()) {
          const need = await f.evaluate(e => {
            if (e.files && e.files.length) return null;
            let box = '', n = e.parentElement, h = 0;
            while (n && h++ < 5) { const t = (n.innerText || '').replace(/\s+/g, ' ').trim(); if (t && t.length < 240) { box = t; break; } n = n.parentElement; }
            return box || 'resume';
          }).catch(() => null);
          if (need === null) continue;
          // Only two documents exist on disk. An upload asking for anything
          // else - a research supplement, writing sample, portfolio, cover
          // letter, references - must NOT be answered with resume.pdf: sending
          // the wrong document is worse than leaving the field empty, and it
          // is the same class of error as filling a country field with "No".
          const OTHER_DOC = /research supplement|writing sample|portfolio|cover letter|references?\b|work sample|publication|essay|photo|headshot|certificate|passport|visa|licen[cs]e/i;
          if (OTHER_DOC.test(need)) {
            unresolvedDocs.push({ q: String(need).slice(0, 140), options: [] });
            continue;
          }
          await f.setInputFiles(docPath(/transcript|academic record/i.test(need) ? 'transcript.pdf' : 'resume.pdf'), { timeout: 12000 }).catch(() => {});
          await p.waitForTimeout(1500);
        }
        rec.phase = 'files';
        s = await gapScan(p);
        if (!s) { rec.status = 'no-modal'; return; }
        if (s.captcha) { rec.status = 'skip-captcha-visible'; return; }
        rec.filled = s.filled; rec.total = s.total;

        // resolve required select gaps one at a time, reading each field's own text
        const unresolved = [...unresolvedDocs];
        for (let pass = 0; pass < 12; pass++) {
          rec.phase = 'select:' + pass;   // survives a JOB_TIMEOUT abort, unlike reqGaps
          const g = await p.evaluate(() => {
            const m = document.querySelector('.ant-modal,[role=dialog]');
            // The modal can re-render or close between passes (answering one
            // gap re-renders the list). Unguarded, that threw "Cannot read
            // properties of null (reading 'querySelectorAll')" and lost a job
            // that was already 19/21 filled. It surfaces more often now that
            // the loop continues past an unresolved gap instead of breaking.
            if (!m) return null;
            for (const f of m.querySelectorAll('[class*=gh-autofill-popup-field]')) {
              const sel = f.querySelector('.ant-select');
              if (sel && !sel.querySelector('.ant-select-selection-item')) {
                const txt = (f.innerText || '').replace(/\s+/g, ' ').trim();
                if (!/\*/.test(txt)) continue;
                document.querySelectorAll('[data-ja-open]').forEach(x => x.removeAttribute('data-ja-open'));
                sel.setAttribute('data-ja-open', '1');
                sel.querySelector('.ant-select-selector')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                return { txt: txt.slice(0, 200) };
              }
            }
            return null;
          }).catch(() => null);
          if (!g) break;
          const readOpts = async () => p.evaluate(() => {
            const dd = [...document.querySelectorAll('.ant-select-dropdown')]
              .filter(d => !d.classList.contains('ant-select-dropdown-hidden') && d.getClientRects().length);
            const scope = dd.length ? dd[dd.length - 1] : null;
            if (!scope) return [];
            const sel = '.ant-select-item-option-content, .ant-select-item-option, [role=option]';
            return [...new Set([...scope.querySelectorAll(sel)]
              .map(e => (e.innerText || '').replace(/\s+/g, ' ').trim())
              .filter(t => t && !/^\d+$/.test(t)))];
          }).catch(() => []);
          // Ant's dropdown is VIRTUALIZED (rc-virtual-list): it only ever has
          // ~9 option nodes in the DOM at once. readOpts therefore returned
          // ["AL","AK","AZ","AR","CA","CO","CT","DE","DC"] for a 50-state
          // select, and any answer past the ninth option could never be
          // matched. Scroll the list holder and accumulate until it stops
          // producing new text.
          const readAllOpts = async () => {
            let all = await readOpts();
            if (!all.length) return all;
            for (let sc = 0; sc < 25; sc++) {
              const more = await p.evaluate(() => {
                const dd = [...document.querySelectorAll('.ant-select-dropdown')]
                  .filter(d => !d.classList.contains('ant-select-dropdown-hidden') && d.getClientRects().length);
                const scope = dd.length ? dd[dd.length - 1] : null;
                if (!scope) return false;
                const h = scope.querySelector('.rc-virtual-list-holder') || scope;
                const before = h.scrollTop;
                h.scrollTop = before + Math.max(80, h.clientHeight - 20);
                return h.scrollTop > before;
              }).catch(() => false);
              if (!more) break;
              await p.waitForTimeout(120);
              const seen = new Set(all);
              for (const o of await readOpts()) if (!seen.has(o)) all.push(o);
            }
            return all;
          };
          let opts = [];
          for (let w = 0; w < 6; w++) {
            await p.waitForTimeout(500);
            opts = await readAllOpts();
            if (opts.length) break;
          }
          if (!opts.length) {
            await p.locator('[data-ja-open] .ant-select-selector').first()
              .click({ timeout: 3000 }).catch(() => {});
            for (let w = 0; w < 6; w++) {
              await p.waitForTimeout(500);
              opts = await readAllOpts();
              if (opts.length) break;
            }
          }
          let choice = opts.length === 1 ? opts[0] : infer(g.txt, opts);
          // One unanswerable dropdown used to abandon the whole application.
          // Ask the model about THIS question, with its real options, right
          // now - the dropdown is open and its text is on screen, which is
          // exactly the moment the answer is unambiguous (see gotchas: a
          // snapshot taken up front desyncs question A onto dropdown B).
          if (!choice && LLM_ON && FACTS) {
            const q1 = { q: g.txt, options: opts.slice(0, 30) };
            const ans = await askLLM([q1], FACTS, { jobTitle: rec.title, ats: 'jobright-easy-apply' }).catch(() => new Map());
            const v = ans.get(lnorm(g.txt));
            if (v) { LLM_ANS.set(lnorm(g.txt), v); choice = fuzzyOpt(opts, v); }
          }
          if (!choice) {
            unresolved.push({ q: g.txt, nopts: opts.length, options: opts.slice(0, 30) });
            // Escape ONLY while a dropdown is actually open. With no dropdown
            // open, Escape closes the whole JobRight modal - the next gapScan
            // then returns null and the run threw, discarding applications
            // that were already 23/26 filled (6 jobs lost on 2026-09-20).
            const dropOpen = await p.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').count().catch(() => 0);
            if (dropOpen) await p.keyboard.press('Escape').catch(() => {});
            continue;   // move on to the NEXT gap instead of abandoning the form
          }
          // Reading an option is not the same as being able to CLICK it: the
          // chosen one may be virtualized out of the DOM (see readAllOpts).
          // Scroll the holder from the top until a node with that exact text
          // exists, then click.
          const optSel = '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content';
          const optLoc = () => p.locator(optSel)
            .filter({ hasText: new RegExp('^' + choice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }).first();
          if (!await optLoc().count().catch(() => 0)) {
            await p.evaluate(() => {
              const dd = [...document.querySelectorAll('.ant-select-dropdown')]
                .filter(d => !d.classList.contains('ant-select-dropdown-hidden') && d.getClientRects().length);
              const scope = dd.length ? dd[dd.length - 1] : null;
              if (scope) (scope.querySelector('.rc-virtual-list-holder') || scope).scrollTop = 0;
            }).catch(() => {});
            for (let sc = 0; sc < 25; sc++) {
              if (await optLoc().count().catch(() => 0)) break;
              const moved = await p.evaluate(() => {
              const dd = [...document.querySelectorAll('.ant-select-dropdown')]
                .filter(d => !d.classList.contains('ant-select-dropdown-hidden') && d.getClientRects().length);
              const scope = dd.length ? dd[dd.length - 1] : null;
              if (!scope) return false;
              const h = scope.querySelector('.rc-virtual-list-holder') || scope;
              const before = h.scrollTop;
              h.scrollTop = before + Math.max(80, h.clientHeight - 20);
              return h.scrollTop > before;
              }).catch(() => false);
              if (!moved) break;
              await p.waitForTimeout(120);
            }
          }
          await optLoc().click({ timeout: 4000 }).catch(() => {});
          await p.waitForTimeout(1100);
        }

        // apply3 only ever answered .ant-select dropdowns. Required TEXT
        // questions were left entirely to the JobRight extension, which fills
        // standard identity fields but never custom ones - so a form sat at
        // 15/23 with three '*(a) If the answer is "Yes," please provide
        // details below:' boxes blocking it forever, even though infer()
        // answers those (N/A by construction). Same resolver, text controls.
        // HAI Group ends at phase text:0 with sparse {modals:0} - the modal
        // VANISHES during the first text-fill iteration and the job is then
        // refused at 2/20. Record a compact trail so the step that loses it is
        // identifiable instead of guessed at.
        const modalGone = async () => !(await p.evaluate(() =>
          [...document.querySelectorAll('.ant-modal, [role=dialog]')].filter(e => e.getClientRects().length).length
        ).catch(() => 1));
        rec.txtTrail = [];
        for (let tp = 0; tp < 8; tp++) {
          rec.phase = "text:" + tp;
          if (await modalGone()) { rec.txtTrail.push(tp + ':gone-before-scan'); break; }
          const t = await p.evaluate(() => {
            const m = document.querySelector('.ant-modal,[role=dialog]');
            if (!m) return null;
            for (const f of m.querySelectorAll('[class*=gh-autofill-popup-field]')) {
              if (f.querySelector('.ant-select') || f.querySelector('input[type=file]')) continue;
              const inp = f.querySelector('input,textarea');
              if (!inp || inp.hasAttribute('data-ja-skip')) continue;
              const ty = (inp.type || '').toLowerCase();
              if (['checkbox', 'radio', 'file'].includes(ty)) continue;
              if (String(inp.value || '').trim()) continue;
              const txt = (f.innerText || '').replace(/\s+/g, ' ').trim();
              if (!/\*/.test(txt)) continue;
              document.querySelectorAll('[data-ja-txt]').forEach(x => x.removeAttribute('data-ja-txt'));
              inp.setAttribute('data-ja-txt', '1');
              return { txt: txt.slice(0, 200) };
            }
            return null;
          }).catch(() => null);
          if (!t) break;
          const tv = infer(t.txt, []);
          if (!tv) {
            // Mark it skipped or the next pass returns the SAME field forever.
            unresolved.push({ q: t.txt, options: [] });
            await p.evaluate(() => document.querySelector('[data-ja-txt]')?.setAttribute('data-ja-skip', '1')).catch(() => {});
            continue;
          }
          // Re-locate by TEXT, not by the injected attribute: a React
          // re-render between tagging and typing drops the attribute and the
          // locator then matches nothing, which reads back as a failed fill.
          let box = p.locator('[data-ja-txt]').first();
          if (!await box.count().catch(() => 0)) {
            const key = t.txt.replace(/[*\u2731]/g, "").trim().slice(0, 40);
            box = p.locator('[class*=gh-autofill-popup-field]').filter({ hasText: key })
                   .locator('input,textarea').first();
          }
          if (process.env.DEBUG_TXT) console.error('[txtfill]', JSON.stringify({ q: t.txt.slice(0, 50), v: String(tv).slice(0, 20), found: await box.count().catch(() => -1) }));
          await box.click({ timeout: 2500 }).catch(() => {});
          if (await modalGone()) { rec.txtTrail.push(tp + ':gone-after-click'); break; }
          await box.pressSequentially(String(tv).slice(0, 300), { timeout: 6000, delay: 12 }).catch(() => {});
          if (await modalGone()) { rec.txtTrail.push(tp + ':gone-after-type'); break; }
          await box.press('Tab').catch(() => {});
          if (await modalGone()) { rec.txtTrail.push(tp + ':gone-after-tab'); break; }
          rec.txtTrail.push(tp + ':ok');
          await p.waitForTimeout(300);
          const got = await box.inputValue({ timeout: 1500 }).catch(() => null);
          if (!got || !String(got).trim()) {
            unresolved.push({ q: t.txt, options: [] });
            await p.evaluate(() => document.querySelector('[data-ja-txt]')?.setAttribute('data-ja-skip', '1')).catch(() => {});
          } else {
            await p.evaluate(() => document.querySelector('[data-ja-txt]')?.setAttribute('data-ja-skip', '1')).catch(() => {});
          }
        }

        // Modal may be gone by now (stray Escape, ATS nav). Keep the last
        // known scan rather than dereferencing null and losing the record.
        s = (await gapScan(p)) || s;
        if (unresolved.length || (s?.reqGaps?.length)) {
          rec.unresolved = (unresolved.length ? unresolved : s.reqGaps.slice(0, 3).map(x => ({ q: x.txt, options: [] }))).slice(0, 4);
          fs.appendFileSync(GAPS, JSON.stringify({ id: j.id, title: rec.title, unresolved: rec.unresolved }) + '\n');
        }
        // Try the submit even with a gap outstanding - JobRight's own modal
        // validates and refuses, which is better evidence than our guess
        // about what it requires. Floor lowered from 8: a short EASY APPLY
        // form is a complete application.
        if (!s || s.filled < 5) {
          rec.status = 'too-sparse-refused';
          // 0/0 is NOT "sparse" - it means the scan saw no form at all, which is
          // a different failure from a short form. Record enough to tell a modal
          // that never opened from one that opened empty.
          rec.sparse = await p.evaluate(() => {
            const m = [...document.querySelectorAll('.ant-modal, [role=dialog]')]
              .filter(e => e.getClientRects().length);
            const top = m[m.length - 1];
            return {
              modals: m.length,
              inputs: top ? top.querySelectorAll('input,select,textarea').length : -1,
              head: top ? (top.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200) : null,
            };
          }).catch(() => null);
          return;
        }
        rec.phase = 'submit';
        if (!SUBMIT) { rec.status = 'READY'; return; }

        // /^Submit$/ is exact-match strict; a modal whose button reads
        // 'Submit Application' scored zero. Accept both, still refusing
        // anything that only advances a step (Next/Continue).
        // Interstates recorded btns:[] at 18/21 - the modal contains no visible
        // <button> at all, so restricting to '<modal> button' could never find
        // the control. Accept the other clickable element types too, and fall
        // back to a page-wide Submit when the modal itself offers none.
        const SUBMIT_TXT = /^Submit(\s+Application)?$/i;
        const inModal = '.ant-modal, [role=dialog], [class*=gh-autofill-popup]';
        const clickable = 'button, input[type=submit], [role=button], a';
        let sb = p.locator(inModal.split(', ').map(m => m + ' ' + clickable.split(', ').join(', ' + m + ' ')).join(', '))
          .filter({ hasText: SUBMIT_TXT }).first();
        if (!await sb.count().catch(() => 0))
          sb = p.locator(clickable).filter({ hasText: SUBMIT_TXT }).first();
        if (!await sb.count().catch(() => 0)) {
          rec.status = 'no-submit-btn';
          // A bare no-submit-btn said nothing about WHY - same evidence gap
          // offsite3 already fixed with rec.btns. Record what the modal offers.
          rec.btns = await p.evaluate(() =>
            [...document.querySelectorAll('.ant-modal, [role=dialog], [class*=gh-autofill-popup]')]
              .flatMap(m => [...m.querySelectorAll('button, input[type=submit], [role=button], a')])
              .filter(e => e.getClientRects().length)
              .map(e => ((e.innerText || '').replace(/\s+/g, ' ').trim() + '#' + (e.id || '')).slice(0, 44))
              .filter(t => t !== '#').slice(0, 25)).catch(() => null);
          // Every no-submit-btn record so far comes back btns:[] - the modal
          // really does contain no visible clickable. So the control must live
          // somewhere else. Record the page-wide list once, with each item's
          // container, instead of guessing where.
          if (!rec.btns || !rec.btns.length) {
            rec.btnsPage = await p.evaluate(() =>
              [...document.querySelectorAll('button, input[type=submit], [role=button], a')]
                .filter(e => e.getClientRects().length)
                .map(e => {
                  const t = (e.innerText || e.value || '').replace(/\s+/g, ' ').trim();
                  const host = e.closest('.ant-modal, [role=dialog], [class*=gh-autofill-popup], form');
                  return (t + '#' + (e.id || '') + '@' + (host ? (host.className || host.tagName).toString().slice(0, 24) : 'none')).slice(0, 70);
                })
                .filter(t => !t.startsWith('#')).slice(0, 40)).catch(() => null);
            // If the control is a bare <div>/<span> with an onclick - no
            // button, no role, no href - even the widened list above misses
            // it. Find anything whose OWN text is "Submit" and describe it.
            rec.submitLike = await p.evaluate(() =>
              [...document.querySelectorAll('*')]
                .filter(e => e.children.length === 0
                  && /^submit(\s+application)?$/i.test((e.textContent || '').replace(/\s+/g, ' ').trim())
                  && e.getClientRects().length)
                .map(e => {
                  let n = e, path = [];
                  for (let i = 0; i < 4 && n; i++, n = n.parentElement)
                    path.push(n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).split(/\s+/)[0] : ''));
                  return path.join('<').slice(0, 90);
                }).slice(0, 8)).catch(() => null);
          }
          return;
        }
        await sb.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
        await sb.click({ timeout: 12000 }).catch(() => {});
        let ok = false;
        for (let k = 0; k < 10; k++) { await p.waitForTimeout(3000); const st = await gapScan(p); if (st?.submitted) { ok = true; break; } }
        if (!ok) {
          // Modal can close on a successful submit too (no "submitted" text left to scan).
          // Fall back to the job-detail page's OWN header badge - scoped to this job,
          // never document.body (nav sidebar's "Applied N" counter false-positives everything).
          const headerApplied = await p.evaluate(() => {
            const el = document.querySelector('.index_jobDetailHeaderContent__lEUKj');
            return el ? /^Applied\b/.test(el.innerText.trim()) : false;
          }).catch(() => false);
          if (headerApplied) ok = true;
        }
        if (!ok) {
          rec.status = rec.unresolved ? 'needs-inference' : 'submit-unconfirmed';
          // submit-unconfirmed carried NO evidence at all - the record had only
          // id/title/phase/filled/total. The skill treats it as a bug until
          // proven otherwise, which is impossible without knowing what the page
          // looked like after the click. Record that.
          rec.afterSubmit = await p.evaluate(() => {
            const m = [...document.querySelectorAll('.ant-modal, [role=dialog]')].filter(e => e.getClientRects().length);
            const top = m[m.length - 1];
            return {
              modals: m.length,
              modalHead: top ? (top.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240) : null,
              errs: [...document.querySelectorAll('.ant-form-item-explain-error, [class*=error]')]
                .map(e => (e.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 6),
              url: location.href.slice(0, 120),
            };
          }).catch(() => null);
          return;
        }
        rec.status = 'SUBMITTED'; rec.marked = 1; sub++;
        const dn = p.locator('.ant-modal button, [role=dialog] button').filter({ hasText: /^Done$/ }).first();
        if (await dn.count().catch(() => 0)) await dn.click({ timeout: 5000 }).catch(() => {});

      } else if (await auto.count().catch(() => 0)) {
        rec.path = 'offsite';
        rec.status = 'offsite-deferred';     // handled in a later pass; keeps this run fast
      } else if (await external.count().catch(() => 0)) {
        // Not a dead end. The 2026-09-23 probe found APPLY NOW's applyLink is
        // usually the employer's own ATS; only a minority are LinkedIn/ZipRecruiter
        // relays (ats_skip.txt). offsite3 opens the applyLink directly, so these
        // go in the offsite batch alongside offsite-deferred.
        rec.status = 'skip-external-redirect';
      } else {
        rec.status = 'no-apply-button';
      }
    })(), JOB_TIMEOUT);
  } catch (e) {
    const msg = String(e.message || e);
    rec.status = 'err:' + msg.slice(0, 40);
    if (DEAD_BROWSER.test(msg)) {
      deadStreak++;
      console.log(`  [browser connection died (streak ${deadStreak}), reconnecting: ${msg.slice(0, 60)}]`);
      const ok = await reconnect();
      // offsite3 learned the hard way that an in-process reconnect often does
      // NOT clear this - the next job dies identically. Better to exit loudly
      // than burn the rest of the queue at a full timeout per job.
      if (!ok || deadStreak >= 2) {
        console.log('browser connection unrecoverable in-process, exiting (restart needed)');
        fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
        process.exit(1);
      }
    } else deadStreak = 0;
  }
  try { if (ext && !ext.isClosed()) await ext.close(); } catch {}
  try { if (p && !p.isClosed()) await p.close(); } catch {}
  fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
  console.log(`[${n}] ${String(rec.status).padEnd(20)} ${rec.filled ?? '-'}/${rec.total ?? '-'} ${rec.title.slice(0, 44)}`);
}
console.log(`\nprocessed=${n} submitted=${sub}`);
// b.close() over CDP can hang forever; a finished run then lingers and
// shares Chrome with the next pass (2026-09-23). Cap it and exit.
await Promise.race([b.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
process.exit(0);
