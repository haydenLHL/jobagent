// offsite3 - second pass over jobs marked 'offsite-deferred' by apply3.
//   /jobs/info/<id> -> APPLY WITH AUTOFILL -> ATS tab -> extension Autofill
//   -> bank fill + inference -> walk wizard -> submit -> "Yes, I applied"
//   password field  -> skip-login   (user rule)
//   INTERACTIVE captcha -> skip     (invisible v3/hCaptcha host frames are fine;
//                                   hosts in ats_allow.txt are never captcha-skipped)
//   unresolved gap  -> gaps.jsonl for subagent inference, no guessing
import { chromium } from 'playwright-core';
import fs from 'fs';
import { extractForm, snapshot, unresolved as unresolvedFields } from './formir.mjs';
import { resolve } from './resolve.mjs';
import { askLLM, norm as lnorm } from './llm.mjs';
import { cleanTitle } from './title.mjs';

// A dialog (alert/confirm/beforeunload) firing on an ATS page can throw from
// inside playwright-core's own internal event listener (DialogManager), on a
// different tick than any of our own try/catch blocks - that crashes the
// WHOLE process silently (no log line, exit code non-zero) rather than
// failing just the one job. Observed live with zero other output produced.
// Log it and exit non-zero so run_offsite_resilient.sh restarts cleanly
// instead of leaving a silent, log-free death.
process.on('uncaughtException', (err) => {
  if (/No dialog is showing/i.test(String(err && (err.stack || err.message) || err))) { console.error('(ignored benign dialog race)'); return; }
  console.error('UNCAUGHT EXCEPTION:', err && err.stack || err);
  process.exit(1);
});
// Benign under parallel workers: every connected worker dismisses every
// dialog in the shared context, and the losers of that race get "No dialog is
// showing" as an unhandled rejection. Exiting on it killed a worker mid-submit
// (GE, 2026-09-24). The dialog WAS handled - log and carry on.
const BENIGN = /No dialog is showing|Target page, context or browser has been closed.*handleJavaScriptDialog/i;
process.on('unhandledRejection', (err) => {
  const m = String(err && (err.stack || err.message) || err);
  if (BENIGN.test(m)) { console.error('(ignored benign rejection:', m.slice(0, 90) + ')'); return; }
  console.error('UNHANDLED REJECTION:', err && err.stack || err);
  process.exit(1);
});

const SUBMIT = process.env.SUBMIT === '1';
const LIMIT = Number(process.env.LIMIT || 9999);
const LEDGER = 'offsite3.jsonl';
const GAPS = 'gaps.jsonl';
const HOME = process.env.HOME;
const SHADOW = process.env.SHADOW !== '0';   // resolver rewrite: observe-only, default on
const SHADOW_LOG = 'shadow.jsonl';
const FACTS = fs.existsSync('answers.json') ? JSON.parse(fs.readFileSync('answers.json', 'utf8')) : null;
if (SHADOW && !FACTS) console.log('(shadow mode: answers.json not found, skipping)');
const normShadow = t => (t || '').toLowerCase().replace(/[*✱＊]/g, '').replace(/\s+/g, ' ').trim();

// Go straight at APPLY WITH AUTOFILL for every harvested job - no EASY APPLY
// pre-pass. Jobs without that button exit in ~4s as 'no-autofill-btn'.
const queue = JSON.parse(fs.readFileSync(process.env.QUEUE_FILE || 'ms_jobs.json', 'utf8'))
  .map(j => ({ id: j.id, title: cleanTitle(j.txt) }))
  .slice(0, LIMIT);
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
// err:* / scan-failed are process hiccups (a dead browser connection, a
// timeout), not a real outcome for the job - never let them count as "done",
// or a connection-death cascade permanently writes off every job it touched.
// A job is only FINISHED when it actually reached a terminal state. Every
// other outcome - needs-inference, too-sparse-refused, no-form-found,
// submit-unconfirmed, no-autofill-btn - is a FAILURE OF OURS, not a property
// of the job, and previously wrote the job off permanently: one bad pass and
// that job could never be applied to again even after the bug was fixed.
// That is the "marked done even though we never applied" problem. Now those
// come back on the next pass, capped by MAX_ATTEMPTS so a genuinely
// impossible job can't spin forever.
const TERMINAL = /^(SUBMITTED|ALREADY-APPLIED|skip-workday|skip-login|skip-listed|skip-account|skip-spam-flagged|skip-apply-limit|skip-closed|skip-paylocity-unsolved|skip-probable-dup)$/;
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
const RUN_ID = new Date().toISOString().slice(0, 16);
const MY_IDS = [];   // job ids this worker has handled - see the tab reaper
const PAST_OWN = []; // OWN sets of earlier jobs - pages that lost their jr_id on redirect
const priorRecs = fs.existsSync(LEDGER)
  ? fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
// Cross-ledger dedupe. apply3.mjs and offsite3.mjs keep SEPARATE ledgers, so
// a job apply3 had already SUBMITTED through EASY APPLY came back round as a
// fresh candidate here - observed live (Clockwork Systems). That risks
// sending the SAME employer a second application, which is worse than missing
// one. Anything either pass finished is finished.
const otherDone = new Set();
if (fs.existsSync('applied3.jsonl')) {
  for (const l of fs.readFileSync('applied3.jsonl', 'utf8').trim().split('\n')) {
    if (!l) continue;
    try { const r = JSON.parse(l); if (/^(SUBMITTED|ALREADY-APPLIED)$/.test(String(r.status))) otherDone.add(r.id); } catch {}
  }
}
const terminalIds = new Set(otherDone), attemptCount = new Map(), timeoutCount = new Map();
for (const r of priorRecs) {
  if (TERMINAL.test(String(r.status))) terminalIds.add(r.id);
  // err:*/scan-failed are process hiccups (dead browser, timeout), not an
  // outcome for the job - they must not burn an attempt either.
  // READY only ever comes from a dry run (SUBMIT unset) - it is a diagnostic,
  // not an attempt, and must not spend the job's retry budget.
  else if (!/^err:|^scan-failed$|^READY$/.test(String(r.status))) attemptCount.set(r.id, (attemptCount.get(r.id) || 0) + 1);
  // ...except a JOB timeout. A job that always times out (a careers search
  // page filled for the whole JOB_TIMEOUT) costs the full budget on EVERY
  // pass forever. Browser-death errors are different messages and stay free.
  // Only a REAL budget exhaustion counts (elapsed >= 150s): a run with an
  // experimental 60s JOB_TIMEOUT must not write off jobs it never gave a chance.
  if (/^err:timeout/.test(String(r.status)) && (r.elapsed || 0) >= 150) timeoutCount.set(r.id, (timeoutCount.get(r.id) || 0) + 1);
}
const MAX_TIMEOUTS = Number(process.env.MAX_TIMEOUTS || 2);
// SKIP_SINCE=<ISO ts>: any job already attempted at/after that time counts as
// done for THIS pass. Each mid-run restart otherwise sends every worker back
// to its shard head to re-fail the same heavy jobs first - after ~10 restarts
// the 4 shards were only ~45/435 deep (2026-09-24). Retry them next pass.
const SKIP_SINCE = process.env.SKIP_SINCE || '';
const triedSince = new Set(SKIP_SINCE ? priorRecs.filter(r => r.ts && r.ts >= SKIP_SINCE).map(r => r.id) : []);
const done = { has: id => terminalIds.has(id) || triedSince.has(id) || (attemptCount.get(id) || 0) >= MAX_ATTEMPTS || (timeoutCount.get(id) || 0) >= MAX_TIMEOUTS };
const LEARNED = fs.existsSync('learned.json') ? JSON.parse(fs.readFileSync('learned.json', 'utf8')) : {};

// Hosts PROVEN fillable by hand despite a captcha being present on the page.
// Verified: jobs.lever.co (Palantir) - 130 inputs, no password, invisible hCaptcha.
const ATS_ALLOW = fs.existsSync('ats_allow.txt')
  ? fs.readFileSync('ats_allow.txt', 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean)
  : [];
const allowed = u => ATS_ALLOW.some(h => String(u || '').includes(h));

// Skipped outright - the autofill link does not land on an application form.
const ATS_SKIP = fs.existsSync('ats_skip.txt')
  ? fs.readFileSync('ats_skip.txt', 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean)
  : [];
const skipListed = t => ATS_SKIP.some(h => String(t || '').toLowerCase().includes(h));

// Boards that will not render an application form without an account
// (Amazon's own portal, LinkedIn/Indeed/ZipRecruiter relays, Eightfold
// career portals). These were showing up as too-sparse-refused /
// no-form-found - an honest label stops us retrying them forever and stops
// them polluting the denominator of the hit rate.
const ATS_ACCOUNT = fs.existsSync('ats_account.txt')
  ? fs.readFileSync('ats_account.txt', 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean)
  : [];
const needsAccount = u => ATS_ACCOUNT.some(h => String(u || '').toLowerCase().includes(h));

const BANK = {
  firstName: 'Liyu', lastName: 'Xiao', fullName: 'Liyu Xiao',
  email: 'liyuxiao2006@gmail.com', phone: '647-894-2609',
  linkedin: 'https://www.linkedin.com/in/liyu-xiao-593176206/',
  github: 'https://github.com/liyuxiao2', website: 'https://liyuxiao.ca/',
  school: 'McMaster University', degree: "Bachelor's Degree", major: 'Computer Science',
  gpa: '3.8',
  employer: 'Wealthsimple', jobTitle: 'Software Engineering Intern',
  empStart: '2026-01', empEnd: '2026-08',
  jobDuties: 'Built a hold-management system in Kotlin with a GraphQL mutation and DAO layer; offloaded logging to an Avro/Kafka/S3/Snowflake pipeline.',
  salary: '90000', start: '2027-01-04', city: 'Toronto', state: 'Ontario', country: 'Canada',
  address1: '61 Frederick Stamm Cres', postal: 'L6C 0X3',
  salaryHourly: '43',
  uniStart: '09/2024',
  gradDate: '2028-04-30', gradMonthYear: '04/2028', gradYear: '2028',
  locPref: 'Open to any of your US office locations; willing to relocate.',
  location: 'Toronto, ON, Canada',
};
function bankValue(l) {
  l = l.toLowerCase();
  if (/full name|your name|legal name|^name$/.test(l)) return BANK.fullName;
  // Pronouns are never derivable from a name field (Battelle got "Xiao").
  if (/pronoun/.test(l)) return null;
  // Name phrasing only. Bare /first|last|family/ matched "where did you FIRST
  // hear", "at LEAST 18", "FAMILY member employed here" (2026-09-24).
  if (/\bfirst[\s_-]*name|given[\s_-]*name|^\W*(first|given)\W*$/.test(l)) return BANK.firstName;
  if (/\blast[\s_-]*name|family[\s_-]*name|surname|^\W*last\W*$/.test(l)) return BANK.lastName;
  if (/e-?mail/.test(l)) return BANK.email;
  // "Phone Extension" matches /phone/ too - filling it with the full 12-char
  // phone number failed WEX's own "less than 8 characters" validation and
  // silently stalled its wizard on step 1 forever (the Next click kept
  // "succeeding" per Playwright, but the ATS's own validator rejected it).
  // \b on BOTH sides: unanchored /ext\b/ matched "conTEXT", "TEXT", "nEXT",
  // so "...further context on preference" returned null and gapped Palantir.
  if (/\bext(ension)?\b|\bext\./i.test(l)) return null;
  // SMS/consent questions mention "phone" but want Yes/No, not a number. The
  // old /ext\b/ bug hid this by nulling anything containing "text".
  if (/text (message|msg)|\bsms\b|may we (text|contact|use)|consent|opt.?in/.test(l)) return null;
  if (/phone|mobile|^tel/.test(l)) return BANK.phone;
  if (/linkedin/.test(l)) return BANK.linkedin;
  if (/github/.test(l)) return BANK.github;
  if (/portfolio|website|personal (site|page)/.test(l)) return BANK.website;
  // University start/end date fields. Ordered ABOVE the /school|university/
  // rule, which would otherwise type 'McMaster University' into a DATE field.
  // A label naming BOTH start and end covers four separate inputs sharing one
  // merged label, so no single value is right for it - gap rather than guess.
  if (/\b(start|end)\b/.test(l) && /(month|year|date)/.test(l) && /(university|college|school)/.test(l)) {
    if (/\bstart\b/.test(l) && /\bend\b/.test(l)) return null;
    if (/\bend\b/.test(l)) return BANK.gradMonthYear;
    return BANK.uniStart;
  }
  if (/school|university|college|institution/.test(l)) return BANK.school;
  // Only YEAR selects had a handler (the all-years list path), so a
  // graduation DATE rendered as a text or date input gapped even though
  // answers.json has had 04/2028 all along. Ashby names it: "Missing entry
  // for required field: Expected Graduation Date". Ordered before /degree/
  // so it is not answered with "Bachelor's Degree".
  if (/graduation|completion date|\bgrad\s*(date|year|month)/.test(l)) {
    if (/month/.test(l)) return BANK.gradMonthYear;
    if (/year/.test(l)) return BANK.gradYear;
    if (/date/.test(l)) return BANK.gradDate;
    return BANK.gradMonthYear;
  }
  if (/major|field of study|discipline/.test(l)) return BANK.major;
  if (/degree/.test(l)) return BANK.degree;
  // GPA lived in answers.json (shadow resolver) but never in BANK, so the
  // live path gapped every 'What is your GPA?' - Ashby names it as the one
  // blocking field in its own validation message.
  if (/\bgpa\b|grade point average/.test(l)) return BANK.gpa;
  // Work-history / education sub-forms (Paylocity's 'Add Work History' and
  // 'Add Education' repeaters) ask for these and nothing in BANK answered
  // them, so a 44/77 form could never pass the ATS's own validation.
  if (/employer|company name|organization name|name of (company|employer)|^current company/.test(l)) return BANK.employer;
  if (/job title|position title|your title|title held/.test(l)) return BANK.jobTitle;
  if (/(duties|responsibilities|describe your (work|role))/.test(l)) return BANK.jobDuties;
  // Hourly before annual: "What are your hourly expectations?" would
  // otherwise fall through to /expected pay/ and answer 90000 per hour.
  if (/hourly|per hour|hr rate|rate of pay/.test(l)) return BANK.salaryHourly;
  if (/salary|compensation|expected pay|desired pay/.test(l)) return BANK.salary;
  if (/start date|availab|when would you (look to |be able to )?start|earliest (start|date)|date you can start|ideal start/.test(l)) return BANK.start;
  if (/preferred location|location preference|other preferred|preferred office|preferred work location/.test(l)) return BANK.locPref;
  // "Current location" / bare "Location" is a required field on Lever and
  // several others and matched NOTHING in here, so it gapped every time.
  if (/current location|^location$|location \(city\)|^where .{0,20}(located|based)|currently based/.test(l)) return BANK.location;
  if (/^city|city\b/.test(l)) return BANK.city;
  if (/administrative area|prefecture/.test(l)) return BANK.state;
  // Word-bounded. Unbounded /state/ matches "United STATES", so every
  // "Are you legally authorized to work in the United States?" resolved to
  // "Ontario" - and the text path consults bankValue FIRST, so that got typed
  // straight into the field. \bstate\b cannot match "states" (no boundary
  // before the trailing s) while still matching "State *", "*State:",
  // "State/Province" and "Select a state".
  if (/\bstate\b|\bprovince\b/.test(l)) return BANK.state;
  if (/country/.test(l)) return BANK.country;
  // "address line 1" / bare "address" only - never matches "address line 2",
  // which has no known value and should gap rather than guess.
  if (/street address|address\s*line\s*1\b|^address$/.test(l)) return BANK.address1;
  if (/zip ?code|postal ?code|post ?code|^zip$|^postcode$/.test(l)) return BANK.postal;
  return null;
}
// Two distinct graduation years. Do not conflate them.
const YEARS = { degree: 2028, highschool: 2024 };
// el.required / aria-required is NOT how most ATSs mark a required field (see
// gotchas). Missing this meant a REQUIRED free-text question was skipped in
// total silence - no fill, no gap - and the submit then failed with the ATS's
// own "this field is required" that we had no answer for.
const REQ_TEXT = /\(required\)|\brequired\b|[\u2731\u273D\uFF0A]|\*\s*$|^\s*\*/;
const reqFromText = t => REQ_TEXT.test(String(t || ''));

const SPONSOR = /requir\w*(\s+\w+){0,3}\s+sponsor|need(\s+\w+){0,3}\s+sponsor|sponsorship (for|to)\b|require .{0,30}(visa|work authorization)|now or in the future require|visa sponsorship/i;
const WORK_AUTH = /legally authoriz|authoriz(ed|ation) to work|eligible to work|legal right to work|right to work|work permit/i;
const EXPORT = /export control|EAR|ITAR|united states citizen|u\.s\. citizen|lawful permanent resident|greencard|green card|protected individual/i;
const EEO = /gender|race|ethnicity|hispanic|latino|veteran|disabilit|self-?identif/i;
// 'permission to text' / SMS opt-in is a consent question and answers.json
// already records terms_consent: yes - it was gapping only because none of
// these keywords covered it.
const YES = /permission to (text|contact)|text (you|messages)|\bsms\b|relocat|on-?site|in[- ]office|in[- ]person|i understand|willing|able to|commute|hybrid|travel|18 years|older|agree|consent|acknowledg|confirm|terms|privacy|background check|reference check|identity[- ]verification|drug (test|screen)|comfortable with|pays \$|hourly rate|be considered for other|proficient/i;
const NO = /referred (to [\w&.'-]+ )?by (an? )?(existing|current) employee|were you referred|applied .{0,25}with us before|previously applied|convict|criminal|felony|misdemeanor|non-?compete|restrictive covenant|relative|family member|related to (an?|any) (\w+ ){0,3}employee|previously (work|employ)|currently employed by|own, operate|other business|outside (employment|business)|conflict of interest|any offers|outstanding offers|offer deadlines|deadlines? (we should|to accept)|other firms|career fair|sponsors for educational opportunity/i;
const DECLINE = /decline|choose not|prefer not|do not wish|don'?t wish|do not want to (answer|disclose|say)|don'?t want to (answer|disclose|say)|not disclose|not to self/i;
const DEMO = /^(male|female|man|woman|non[- ]?binary|white|asian|black|hispanic|latin[oax]|native|american indian|two or more)\b|veteran|disabilit/i;
// Answers the LLM resolved for the CURRENT form. Consulted before every rule:
// it has the full question text and the real option list, which the regexes
// below do not. Keyed by normalized question text.
const LLM_ANS = new Map();
// Gaps are logged with the question cut to 140 chars, so a longer question
// was keyed shorter than the full-text lookup and its LLM answer was silently
// never applied (Quadric relocate radio, 2026-09-24). Fall back to a prefix.
const llmGet = q => { const k = lnorm(q); if (!k) return undefined; if (LLM_ANS.has(k)) return LLM_ANS.get(k);
  for (const [kk, v] of LLM_ANS) if (kk.length >= 40 && k.length >= 40 && (k.startsWith(kk) || kk.startsWith(k))) return v; return undefined; };
// A learned/bank answer almost never matches an option string exactly
// ("Personal Mobile" vs "Mobile", "Canada" vs "CA - Canada"). Requiring
// equality made learned.json nearly inert - `phone device type` was cached
// and still gapped 16 times.
const nkey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function fuzzyOpt(opts, want) {
  if (!want) return null;
  const w = nkey(want); if (!w) return null;
  const cand = opts.filter(o => nkey(o));
  return cand.find(o => nkey(o) === w)
      || cand.find(o => nkey(o).split(' ').includes(w))
      || cand.find(o => w.split(' ').includes(nkey(o)))
      // Whole-word containment only. Raw substring picked "AR" for Ontario
      // ("ontARio") on Battelle's US-state list (2026-09-24) - any 2-letter
      // code list was exposed (CA for "Canada" too).
      || cand.find(o => { const k = nkey(o); const wb = (a, b) => new RegExp(`(^| )${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(a); return wb(k, w) || wb(w, k); })
      || null;
}
// Some ATSs (Lever's education "cards", several Oracle Cloud blocks) give the
// control a machine-generated name and no usable label at all -
// "cards[3da58b41-...][field0]" for a university picker with 3000 options. No
// label-based rule can ever answer those. The OPTION LIST itself identifies
// the field.
function optionKind(opts) {
  const n = opts.length; if (n < 4) return null;
  const frac = re => opts.filter(o => re.test(String(o))).length / n;
  if (frac(/universit|college|institute|\bschool\b|polytechnic|\bécole\b/i) > 0.4) return 'school';
  if (frac(/bachelor|master'?s|doctor|associate|\bph\.?d\b|diploma|high school|\bmba\b|certificate/i) > 0.4) return 'degree';
  if (frac(/engineering|computer|science|mathematic|business|biolog|chemistr|econom|psycholog|nursing/i) > 0.35) return 'major';
  return null;
}
const USELESS_LABEL = /^\s*$|^cards?\[|^field\d|^\(unlabeled|^[\d\W_]+$|^q\d+$|^input\d*$/i;
const learnedFreeText = (q, v) => {
  const bare = /^(yes|no)$/i.test(String(v).trim());
  const head = String(q).replace(/^[\s*\u2731\u200b]+/, "");
  if (bare && /^(what|which|how|when|where|who|why)\b/i.test(head)) return null;
  return (/\?/.test(q) || !bare) ? v : null;
};
const EDU_START_YEAR = 2024;   // answers.json education[0].start_year
// Audit trail: every multiple-choice answer infer() picks is recorded on the
// job's ledger record (rec.answers), so a wrong claim is visible after the
// fact. Two wrong-data bugs (fuzzy "AR" for Ontario, "Yes- I'm in SF") were
// only found by accident on 2026-09-24.
let ANS_LOG = [];
let CUR_JOB = null;   // current queue entry, for per-step LLM context
function infer(q, opts) {
  const r = infer0(q, opts);
  if (r && opts && opts.length > 1 && ANS_LOG.length < 80) ANS_LOG.push(`${String(q).replace(/\s+/g, ' ').slice(0, 70)} => ${String(r).slice(0, 60)}`);
  return r;
}
function infer0(q, opts) {
  const find = re => opts.find(o => re.test(o));
  // The "question" IS one of the options: the label extractor read the
  // control's displayed value (Rippling EEO selects already showing "Choose
  // not to disclose", 2026-09-24 - the top gap of the night). Keep what is
  // shown. Never for a placeholder, which is not an answer.
  {
    const qk = nkey(q);
    const same = qk && !/^(please )?select|^choose (one|an option)$|^none selected$/.test(qk) ? opts.find(o => nkey(o) === qk) : null;
    if (same) return same;
  }
  // "Source" / "How did you hear" pickers: LinkedIn is the answer learned.json
  // already gives; a Phenom parent "Source Type" has no LinkedIn, only
  // categories - JobRight is a website, so "Website" (which unlocks the
  // child list that does contain LinkedIn).
  if (/\bsource\b|hear about/i.test(q) && opts.length) {
    const li = opts.find(o => /^linked ?in\b/i.test(o.trim())); if (li) return li;
    const web = opts.find(o => /^(website|job board|internet|online( job board)?|job posting site)$/i.test(o.trim())); if (web) return web;
  }
  // A contact-CHANNEL picker (Cisco/Phenom "Send SMS / Send Emails / Send
  // WhatsApp") left Next disabled; its question label is unreliable (it read
  // as the Country field above it). Email is the channel on every form we
  // submit, so answer it from the options alone.
  if (opts.length >= 2 && opts.every(o => /\b(sms|e-?mails?|whatsapp|text( message)?s?|phone|call)\b/i.test(o))) {
    const em = opts.find(o => /e-?mail/i.test(o));
    if (em) return em;
  }
  const llm = llmGet((q));
  if (llm) { const m = fuzzyOpt(opts, llm); if (m) return m; if (!opts.length) return llm; }
  for (const [k, v] of Object.entries(LEARNED))
    // See apply3: without the !opts.length fallback a learned answer can only
    // ever fill a field that has options, never a free-text one.
    if (q.toLowerCase().includes(k.toLowerCase())) { const m = fuzzyOpt(opts, v); if (m) return m; if (!opts.length) { const fv = learnedFreeText(q, v); if (fv) return fv; } }
  // Education status, derived from answers.json education[0] (currently
  // enrolled, graduating 2028-04). Activision/Phenom asked these on a later
  // wizard step, which never got an LLM pass, so they blocked the form.
  if (opts.length && !/high school|secondary/i.test(q)) {
    if (/graduat|completion/i.test(q) && opts.some(o => /\b20\d\d\b/.test(o) && /spring|fall|summer|winter/i.test(o))) {
      const t = opts.find(o => /\b2028\b/.test(o) && /spring/i.test(o)); if (t) return t;
    }
    const yes = find(/^\s*yes\s*[.!]?\s*$/i);
    // Not "full-time": answers.json has no full-time fact (never guess).
    if (yes && !/full[- ]?time/i.test(q) && /currently enrolled|currently (a )?(student|in school)|enrolled in (an? )?(accredited )?(degree|university|college|school|program)|currently pursuing (a |an |further )?(degree|education|post-?secondary)|(returning|return) to school|continue to be enrolled|remain enrolled|will you (still )?be (a |an )?(enrolled )?student/i.test(q)) return yes;
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
  // Bare "Source*" select = "how did you hear about us" (referral: LinkedIn).
  if (opts.length && /^\W*(applicant |candidate |job |recruitment )?source\b/i.test(q)) { const li = fuzzyOpt(opts, 'LinkedIn'); if (li) return li; }
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
      if (ym) {
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
  if (opts.length && /location preference|preferred location|top location|which office|office (would you |you would )?prefer|location.{0,12}prefer/i.test(q)) {
    const real = opts.find(o => o && !/^\d+$/.test(o) && !/^(select|choose|please select|--|none|other)/i.test(o.trim()));
    if (real) return real;
  }
  // A degree dropdown that lists SPECIFIC degrees ("Bachelor of Arts",
  // "Bachelor of Science", "Master of Science", ...) never fuzzy-matches the
  // generic BANK.degree "Bachelor's Degree", so it gapped with the answer in
  // hand (Freddie Mac: navErrs said "Select degree"). answers.json has a
  // B.A.Sc. in Computer Science, so prefer a Bachelor-of-Science option, then
  // any bachelor-level one. Never pick a Master/Doctorate we do not hold.
  if (opts.length >= 2 && opts.filter(o => /^\s*(bachelor|master|associate|doctor)/i.test(o)).length >= 2) {
    const bs = opts.find(o => /^\s*bachelor\s+of\s+science/i.test(o))
            || opts.find(o => /^\s*bachelor/i.test(o));
    if (bs) return bs;
  }
  // "How did you hear about us?" is one of the most common required questions
  // on every ATS, and learned.json answers it "LinkedIn" - but plenty of forms
  // do not OFFER LinkedIn (Excellus: ["Agency","College Campus/High School
  // Campaign",...]), so fuzzyOpt failed and a 14/16 form died on this one
  // field. Fall back down a chain that stays TRUTHFUL: the posting really was
  // found on an online job board (JobRight), so a job-board/internet option is
  // accurate; "Other" only as a last resort. Never pick Agency/Referral/Career
  // Fair - those would be false.
  // "Where did you FIRST hear about REV's internship opportunities?" (Indeed or
  // other career site) and a bare "Source" list with no LinkedIn fell through.
  if (opts.length && (/(how|where) did you (first )?(hear|find out|learn) about|how did you find (us|this|out)|referral source|source of (application|referral)/i.test(q)
      || /^\W*(applicant |candidate |job |recruitment )?source\b/i.test(q))) {
    const pick = re => opts.find(o => re.test(o));
    const hit = pick(/linkedin/i)
             || pick(/job\s*board|online|internet|job\s*(search|posting)\s*site|indeed|glassdoor|other (career|job) (site|board|website)/i)
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
  }
  if (WORK_AUTH.test(q)) return find(/^no/i) || null;
  if (EXPORT.test(q)) return find(/^other/i) || null;   // Canadian citizen: not USC/LPR/protected
  if (EEO.test(q)) return find(DECLINE) || null;
  // Ashby renders EEO radio groups with no reachable label (q === ''), so the
  // EEO test above never fires and gender/race gapped on ~25 jobs. When the
  // OPTIONS are themselves demographic and one is a decline, apply the same
  // decline policy answers.json sets for every EEO field.
  if (opts.some(o => DECLINE.test(o)) && opts.filter(o => DEMO.test(o)).length >= 2) return find(DECLINE);
  // The bank already knows city/state/country/school/degree/major/etc. infer()
  // never consulted it, so every one of those rendered as a <select> or a
  // radio group gapped even though the answer was sitting right there
  // ("City" x40, "Country" x39, "Address Line 1" x23 in one session's gaps).
  const bv = bankValue(q);
  if (bv) { const m = fuzzyOpt(opts, bv); if (m) return m; if (!opts.length) return bv; }
  // Label useless, or the label-based bank lookup found nothing: fall back to
  // what the options themselves say the field is.
  if (!bv || USELESS_LABEL.test(q)) {
    const kind = optionKind(opts);
    const want = kind === 'school' ? BANK.school : kind === 'degree' ? BANK.degree : kind === 'major' ? BANK.major : null;
    if (want) { const m = fuzzyOpt(opts, want); if (m) return m; }
  }
  if (/country/i.test(q)) return find(/canada/i) || null;
  if (/state|province/i.test(q)) return find(/ontario/i) || null;
  // Bare yes/no (or "Yes, I agree"-style) only. /^yes/ took "Yes- I'm in
  // San Francisco Bay Area and willing to work hybrid..." for a Toronto
  // candidate (Quadric/Ashby, 2026-09-24): a qualified option carries its own
  // factual claim. Those go to the LLM, which sees the options and FACTS.
  const BARE = w => new RegExp(`^\\s*${w}\\s*[.!,\\-\u2013]?\\s*((i\\s+)?(agree|accept|consent|understand|acknowledge|confirm|do|can|will|am|have|would)\\s*)?[.!]?\\s*$`, 'i');
  if (YES.test(q)) return find(BARE('yes')) || null;
  if (NO.test(q)) return find(BARE('no')) || null;
  return null;
}

// Label resolver injected into the page. Unlabeled required fields were the main
// blocker before: ATS forms often put the question in a wrapper div or a
// preceding sibling rather than a real <label for>.
const LBL_SRC = `function LBL(e){
  const clean=t=>(t||'').replace(/\\s+/g,' ').trim();
  // Oracle Cloud Recruiting (and others) render a live character-remaining
  // counter ("1000", "45/500") as a sibling right next to the control. It is
  // short and non-empty, so the ancestor/sibling climb below grabbed it as
  // the label before ever reaching the real question text further out.
  const isCounter=t=>/^\\d+$/.test(t)||/^\\d+\\s*\\/\\s*\\d+$/.test(t);
  let l='';
  if(e.id){const x=document.querySelector('label[for="'+CSS.escape(e.id)+'"]'); if(x)l=clean(x.innerText);}
  if(!l&&e.closest('label'))l=clean(e.closest('label').innerText);
  if(!l){const ab=e.getAttribute('aria-labelledby'); if(ab){const t=document.getElementById(ab); if(t)l=clean(t.innerText);}}
  if(!l)l=clean(e.getAttribute('aria-label')||'');
  if(!l)l=clean(e.placeholder||'');
  if(isCounter(l))l='';
  const marker=t=>clean((t||'').replace(/[\u200b\u2731\u273D\uFF0A*]/g,' ').replace(/\b(required|optional|this field is required)\b/gi,' '));
  if(!l){let n=e.parentElement,h=0; while(n&&h++<5){const t=clean(n.innerText); if(t&&t.length<220&&!isCounter(t)&&marker(t).length>=4){l=t;break;} n=n.parentElement;}}
  if(!l){let s=e.previousElementSibling,h=0; while(s&&h++<3){const t=clean(s.innerText); if(t&&t.length<160&&!isCounter(t)){l=t;break;} s=s.previousElementSibling;}}
  if(!l)l=clean((e.name||'').replace(/[_\\-]+/g,' '));
  return l;
}
// Walk UP until the ancestor's text, with the option labels stripped out, still
// has real content - that residue is the question. Lever nests the question 5
// levels above the input, and every closer ancestor reads only "Yes No".
function QUP(e,opts){
  const clean=t=>(t||'').replace(/\\s+/g,' ').trim();
  const strip=t=>{let r=t;for(const o of (opts||[])){if(o&&o.length)r=r.split(o).join(' ');}
    return r.replace(/[*\u2731\u2718\u00d7]/g,' ').replace(/\\s+/g,' ').trim();};
  let n=e,h=0;
  while(n&&h++<7){
    n=n.parentElement; if(!n)break;
    const t=clean(n.innerText);
    if(!t)continue;
    if(t.length>600)break;
    if(strip(t).length>=8)return t;
  }
  return '';
}`;

const scan = pg => pg.evaluate(lbl => {
  eval(lbl);
  // A captcha only blocks if it is ACTUALLY RENDERED. hCaptcha/reCAPTCHA always
  // inject full-size host iframes with visibility:hidden, and invisible-mode
  // containers lay out at height 0. Neither needs any interaction.
  const big = e => {
    if (e.offsetWidth <= 10 || e.offsetHeight <= 10) return false;
    const st = getComputedStyle(e);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.1) return false;
    const r = e.getBoundingClientRect();
    if (r.width <= 10 || r.height <= 10) return false;
    return r.bottom > 0 && r.right > 0 && r.top < document.documentElement.scrollHeight;
  };
  const ifr = [...document.querySelectorAll('iframe')];
  // ONLY a visible v2 widget/challenge blocks; invisible v3 is harmless.
  // Record WHICH element tripped the skip and how big it rendered. A bare
  // captcha:true gave no way to tell a real v2 checkbox (JazzHR) from an
  // invisible-mode container that happens to lay out (suspected on Eightfold).
  let capWhy = null;
  const capFrame = ifr.find(f => /recaptcha.*api2\/anchor|recaptcha.*bframe|hcaptcha.*(checkbox|challenge)/i.test(f.src || '') && big(f));
  if (capFrame) capWhy = 'iframe ' + String(capFrame.src).slice(0, 80) + ' ' + capFrame.offsetWidth + 'x' + capFrame.offsetHeight;
  if (!capWhy) {
    // A .g-recaptcha class ON a button is invisible reCAPTCHA bound to the
    // submit click (ADP <sdf-button class="g-recaptcha">, 100x40), not a
    // widget anyone has to solve - 3 ADP jobs were skipped on it (09-25).
    // Cloudflare Turnstile in managed mode usually passes by itself: the
    // response token is already set and there is no visible challenge iframe.
    // Citadel was skipped on a 1088x148 wrapper holding a solved token (09-25).
    const tsPassed = e => e.classList.contains('cf-turnstile') && (!!e.querySelector('input[name="cf-turnstile-response"]')?.value || ![...e.querySelectorAll('iframe')].some(big));
    const btnLike = e => /^(button|input|a|sdf-button|oc-button|spl-button|ukg-button|adp-button)$/i.test(e.tagName) || e.getAttribute('role') === 'button' || e.getAttribute('data-size') === 'invisible';
    const capEl = [...document.querySelectorAll('.g-recaptcha,[data-sitekey],.cf-turnstile')].find(e => big(e) && !btnLike(e) && !tsPassed(e));
    if (capEl) capWhy = 'el ' + capEl.tagName.toLowerCase() + '.' + String(capEl.className).slice(0, 40) + ' ' + capEl.offsetWidth + 'x' + capEl.offsetHeight;
  }
  // Full-page bot wall (SmartRecruiters/DataDome "Verification Required ...
  // Slide right to secure your access"). No form underneath; it was being
  // filed no-submit-btn / adv-stuck0 (CRB, Veolia, 2026-09-25). A human
  // challenge: skip, never solve.
  if (!capWhy && /verification required/i.test(document.body?.innerText || '') && /slide right|unusual activity|automated \(bot\) activity/i.test(document.body?.innerText || '')) capWhy = 'bot-wall verification-required';
  const captcha = !!capWhy;
  let filled = 0, total = 0; const req = [];
  // Collect across shadow boundaries. Capped: a web-component ATS can carry
  // ~2000 shadow roots and an uncapped walk of every root's subtree is slow.
  const __els = (() => {
    const acc = [], seen = new Set();
    let roots = 0;
    const walk = root => {
      if (roots++ > 4000) return;
      try { acc.push(...root.querySelectorAll('input,select,textarea')); } catch (_) { return; }
      let hosts;
      try { hosts = root.querySelectorAll('*'); } catch (_) { return; }
      for (const e of hosts) if (e.shadowRoot && !seen.has(e)) { seen.add(e); walk(e.shadowRoot); }
    };
    walk(document);
    return [...new Set(acc)];
  })();
  __els.forEach(e => {
    const ty = (e.type || e.tagName).toLowerCase();
    if (['hidden', 'submit', 'button'].includes(ty)) return;
    // Cookie-consent widgets (OneTrust et al.) and their hidden template clones
    // are not part of the application. A corporate career-portal landing page
    // commonly carries 5-10 pre-checked cookie toggles, which inflated
    // total/filled past the reveal-gate threshold and made the script treat
    // the cookie-preferences widget as "the form" without ever clicking the
    // real Apply button (seen on jobs.paccar.com, careers.lyondellbasell.com).
    // File inputs are exempt: a styled resume dropzone's real input is
    // display:none / 0x0 behind a visible label, and dropping it here made
    // SmartRecruiters OneClick read as a page with no controls at all.
    if (String(e.type || '').toLowerCase() !== 'file' && e.offsetWidth <= 0 && e.offsetHeight <= 0) return;   // hidden/template clone
    const lblForFilter = LBL(e);
    if (/cookie/i.test(lblForFilter)) return;
    total++;
    if (ty === 'checkbox' || ty === 'radio') { if (e.checked) filled++; return; }
    // A file input's .value is '' even with a file attached (browsers hide the
    // real path), so every resume/transcript upload counted as EMPTY: it never
    // incremented `filled` and, when marked required, it landed in req[] - a
    // permanent phantom "Resume" gap on a form whose resume was attached
    // correctly. That pushed fully-filled forms into needs-inference and
    // dragged `filled` below the too-sparse floor.
    if (ty === 'file') { if (e.files && e.files.length) filled++; else if (e.required || e.getAttribute('aria-required') === 'true') req.push((lblForFilter || '(file)').slice(0, 110)); return; }
    if (String(e.value || '').trim()) { filled++; return; }
    if (e.required || e.getAttribute('aria-required') === 'true') req.push((lblForFilter || '(unlabeled)').slice(0, 110));
  });
  return { filled, total, req, captcha, capWhy, pw: __els.filter(e => String(e.type || '').toLowerCase() === 'password').length,
           step: (document.body.innerText.match(/step\s*\d+\s*of\s*\d+/i) || [])[0] || null };
}, LBL_SRC).catch(() => null);

// Free-text fields the bank does not cover used to be skipped in total
// silence - no fill, no gap, nothing for the LLM to answer. A REQUIRED one
// then surfaced only as an opaque entry in scan()'s req[] list, far too late
// in the pass to do anything about. Now they gap like every other control,
// and an LLM answer from the current form is usable here too.
async function fillText(pg) {
  const unresolved = [];
  for (let __sweep = 0; __sweep < 2; __sweep++) {
  const __before = unresolved.length;
  // Exclude the non-text types IN THE SELECTOR. They were skipped anyway, but
  // only after a full evaluate() each (LBL source + ancestor climb); Palantir's
  // 33-language radio matrix made text1 alone take 207s of a 553s job
  // (DEBUG_TIME, 2026-09-24).
  for (const el of await pg.locator('input:visible:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=image]):not([type=reset]), textarea:visible').all()) {
    if (process.env.DEBUG_TIME && globalThis.__fld) { const d = Date.now() - globalThis.__fld.t; if (d > 3000) console.error(`[slowfield] ${d}ms ${globalThis.__fld.l}`); }
    globalThis.__fld = { t: Date.now(), l: '?' };
    const m = await el.evaluate((e, lbl) => { eval(lbl);
      const ty = (e.type || e.tagName).toLowerCase();
      // Walk a few ancestors for the required marker too - Lever/Greenhouse
      // put the glyph on the wrapper, not on the label the input points at.
      // Climb for the question text, not just for ANY text. Dover wraps each
      // input in a div whose entire text is a zero-width space plus the word
      // "Required" - short, non-empty, and completely useless, so the old
      // first-non-empty-ancestor rule stopped there and every field on the
      // form gapped with the label "\u200b Required". Require real residue
      // once the marker words are stripped, the same way QUP() does.
      const residue = t => (t || '').replace(/[\u200b\u2731\u273D\uFF0A*]/g, ' ')
        .replace(/\b(required|optional|this field is required)\b/gi, ' ').replace(/\s+/g, ' ').trim();
      let box = '', n = e.parentElement, h = 0;
      while (n && h++ < 5) {
        const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 400 && residue(t).length >= 6) { box = t; break; }
        n = n.parentElement;
      }
      // Mark each combobox once handled so later sweeps (text2, post-LLM)
      // don't re-commit it again - see the jaDone check below.
      const cmb = e.getAttribute('role') === 'combobox' || !!e.getAttribute('aria-autocomplete') || e.getAttribute('aria-expanded') !== null || e.id === 'location-input';
      const done = e.dataset.jaDone === '1'; if (cmb) e.dataset.jaDone = '1';
      // react-select (new Greenhouse boards): the <input> stays empty and the
      // chosen value renders in a sibling, so fillText saw "empty" and retyped
      // Country/work-auth every sweep, 8-28s each - 24/24 Greenhouse embed
      // jobs timed out in fill (2026-09-24). fillComboboxes owns these.
      const rs = !!e.closest('[class*="select__control"],[class*="select__value-container"]');
      return { ty, l: LBL(e), v: String(e.value || ''), box, done, rs,
               // An <input role=combobox> looks like a text box and fills like
               // one, but the ATS ignores typed text until an option from its
               // own dropdown is chosen (Ashby's "Where are you currently
               // located?"). Has to be handled differently from a plain input.
               // Lever's #location-input carries no ARIA at all but only accepts a
               // picked suggestion - and the full "Toronto, ON, Canada" returns none.
               combo: e.getAttribute('role') === 'combobox' || !!e.getAttribute('aria-autocomplete') || e.getAttribute('aria-expanded') !== null || e.id === 'location-input',
               req: !!(e.required || e.getAttribute('aria-required') === 'true') };
    }, LBL_SRC).catch(() => null);
    if (!m || ['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(m.ty)) continue;
    if (m.rs) continue;
    if (globalThis.__fld) globalThis.__fld.l = String(m.l || m.box || '').slice(0, 50) + (m.v ? ' [had value]' : '') + (m.combo ? ' [combo]' : '');
    // A combobox that ALREADY HAS TEXT is the dangerous case, not the safe
    // one. The JobRight extension types the right city into Ashby's location
    // typeahead and never picks a suggestion, so the box reads "Toronto" to
    // us and the field reads EMPTY to Ashby - the submission then fails with
    // "Missing entry for required field: Where are you currently located?"
    // on a form that looked 100% filled. Re-commit instead of skipping;
    // re-selecting the same suggestion is harmless.
    // The extension types the last name into "Personal Pronouns" (Battelle,
    // 2026-09-24). Clear a pronouns field holding a name; leave it blank.
    if (m.v && /pronoun/i.test(m.l || m.box || '') && [BANK.firstName, BANK.lastName, BANK.fullName].some(n => n && m.v.trim().toLowerCase() === String(n).toLowerCase())) {
      await el.fill('', { timeout: 2000 }).catch(() => {}); continue;
    }
    const recommit = m.combo && !!m.v;
    if (m.v && !recommit) continue;
    // The label can be marker-only even when the wrapper carries the real
    // question - use whichever actually says something.
    const labelText = (m.l && m.l.replace(/[\u200b\u2731*]|required|optional/gi, '').trim().length >= 4) ? m.l : (m.box || m.l);
    // The text path consulted bankValue and the LLM cache but NEVER learned.json,
    // so every free-text question we had already resolved by hand gapped again.
    const learned = Object.entries(LEARNED).find(([k]) => labelText.toLowerCase().includes(k.toLowerCase()) && learnedFreeText(labelText, LEARNED[k]));
    const required = m.req || reqFromText(m.l) || reqFromText(m.box);
    // A REQUIRED "Address Line 2" (Phenom: GE, CAI) with no unit to give: the
    // truthful entry is "N/A". Optional ones stay blank (bankValue still
    // refuses line 2 on purpose). It was the last blocker on the GE family
    // once the Country/Province fix landed (2026-09-24).
    const line2 = required && /address\s*(line\s*)?2\b|apartment|suite|unit number/i.test(labelText) ? 'N/A' : null;
    const v = bankValue(labelText) || (learned ? learned[1] : null) || llmGet((labelText)) || llmGet((m.l)) || line2 || (recommit ? m.v : null);
    if (process.env.DEBUG_TXT && !v) console.error('[txt-unresolved]', JSON.stringify({ l: m.l, box: m.box, labelText, bv: bankValue(labelText), mv: m.v, req: required }));
    if (!v) { if (required && labelText && !/cookie/i.test(labelText)) unresolved.push({ q: labelText.slice(0, 300), options: [], required: true }); continue; }
    // A combobox this job already committed, still showing the answer: the
    // re-commit is pure cost. Every sweep re-committed every filled combo, up
    // to 4 passes per job, and on Rippling that was ~100s of a 240s budget
    // (race picker 78s+35s, phone-code "Search" 4 x 5-10s) -> fill-phase
    // timeouts on 7 of 7 Rippling jobs (DEBUG_TIME, 2026-09-24).
    if (recommit && m.done && String(m.v).toLowerCase().includes((String(v).split(',')[0].trim() || String(v)).toLowerCase())) continue;
    const typeahead = m.combo || /location|city|address|school|universit|company|country|state|province/i.test(labelText);
    // A typeahead only matches on a SHORT query - "Toronto, ON, Canada" pasted
    // whole returns no suggestions at all, so nothing gets committed and the
    // ATS reports the field as empty ("Missing entry for required field: Where
    // are you currently located?") while it visibly shows the right text.
    // Type the first token, let it search, then take the suggestion.
    const shortQ = String(v).split(',')[0].trim() || String(v);
    let filledOk = await el.fill(m.combo ? shortQ : v, { timeout: 3000 }).then(() => true).catch(() => false);
    if (!filledOk) filledOk = await el.click({ timeout: 2000 }).then(() => el.pressSequentially(v, { timeout: 3000 }).then(() => true)).catch(() => false);
    // Verify the value actually committed. fill() reporting success is not
    // evidence; only reading it back is.
    if (filledOk && !m.combo) {
      const got = await el.inputValue({ timeout: 1500 }).catch(() => null);
      if (got !== null && !String(got).trim()) {
        await el.click({ timeout: 1500 }).catch(() => {});
        await el.pressSequentially(String(v), { timeout: 4000, delay: 12 }).catch(() => {});
        const got2 = await el.inputValue({ timeout: 1500 }).catch(() => null);
        if (process.env.DEBUG_TXT) console.error('[txt-recommit]', JSON.stringify({ l: String(labelText).slice(0, 50), want: String(v).slice(0, 30), afterFill: got, afterType: got2 }));
        if (got2 !== null && !String(got2).trim()) filledOk = false;
      }
    }
    if (process.env.DEBUG_TA) console.error(`[TA] label=${JSON.stringify(labelText.slice(0,60))} combo=${m.combo} v=${JSON.stringify(String(v).slice(0,40))} filledOk=${filledOk} typeahead=${typeahead}`);
    if (filledOk && typeahead) {
      // .dropdown-location: Lever's "Current location" suggestions are plain
      // divs (no role, no listbox), so none of the generic selectors saw them
      // and every Lever form with that field failed "Please select a location
      // from the dropdown menu and try again" on submit (9 jobs, 2026-09-23).
      const OPT = '[role=option]:visible, [class*="select__option"]:visible, li[role=option]:visible, [class*="autocomplete"] li:visible, [role=listbox] li:visible, .dropdown-results .dropdown-location:visible';
      let opt = pg.locator(OPT).first();
      for (let k = 0; k < 3 && !(await opt.count().catch(() => 0)); k++) {
        await pg.waitForTimeout(1000);
        opt = pg.locator(OPT).first();
      }
      // Some typeaheads search on keystrokes only - fill() sets the value with
      // no key events, so Lever's location box showed "No location found"
      // with 0 suggestions. Live probe 2026-09-23: fill -> 0, typed -> 4. Retype.
      if (m.combo && !(await opt.count().catch(() => 0))) {
        await el.fill('', { timeout: 2000 }).catch(() => {});
        await el.click({ timeout: 2000 }).catch(() => {});
        await el.pressSequentially(shortQ, { delay: 70, timeout: 6000 }).catch(() => {});
        for (let k = 0; k < 4 && !(await opt.count().catch(() => 0)); k++) {
          await pg.waitForTimeout(800);
          opt = pg.locator(OPT).first();
        }
      }
      if (process.env.DEBUG_TA) console.error(`[TA]   optCount=${await pg.locator(OPT).count().catch(() => -1)} texts=${JSON.stringify(await pg.locator(OPT).evaluateAll(ns => ns.slice(0,3).map(n => (n.innerText||'').trim().slice(0,40))).catch(() => 'ERR'))}`);
      if (await opt.count().catch(() => 0)) {
        // Prefer a suggestion that actually mentions what we typed over
        // whatever happens to be first in an unrelated open listbox.
        const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const better = pg.locator(OPT).filter({ hasText: new RegExp(esc(shortQ), 'i') }).first();
        // "Toronto" alone matches "Toronto, OH, USA" too; prefer the one that
        // also carries the value's second token (ON).
        const tok2 = String(v).split(',')[1]?.trim();
        const best = tok2 ? pg.locator(OPT).filter({ hasText: new RegExp(esc(shortQ), 'i') }).filter({ hasText: new RegExp(`\\b${esc(tok2)}\\b`, 'i') }).first() : null;
        let target = best && await best.count().catch(() => 0) ? best : await better.count().catch(() => 0) ? better : opt;
        // Re-committing the field's OWN displayed value must never fall back
        // to "first option". Rippling's phone-country picker (label "Search")
        // shows "+1 US"; the list does not filter on that, so the first option
        // got clicked and every sweep walked the code +1 US -> +998 UZ ->
        // +598 UY -> +39 VA, leaving an invalid phone that silently blocked
        // submit (DEBUG_TA, 2026-09-24). No matching suggestion = leave as is.
        const fromShown = recommit && String(v) === String(m.v);
        if (fromShown && target === opt) target = null;
        if (!target) { const host = kbHost(pg); if (host) await host.keyboard.press('Escape').catch(() => {}); continue; }
        await target.click({ timeout: 2500 }).catch(() => {});
        await pg.waitForTimeout(500);
        // Some typeaheads only commit on keyboard selection - a click on the
        // option row is handled by a mousedown listener the synthetic click
        // sequence misses. ArrowDown+Enter is the universal commit.
        const stillOpen = await pg.locator(OPT).first().count().catch(() => 0);
        if (stillOpen) {
          const host = kbHost(pg);
          if (host) { await host.keyboard.press('ArrowDown').catch(() => {}); await host.keyboard.press('Enter').catch(() => {}); await pg.waitForTimeout(400); }
        }
      } else if (m.combo) {
        // No suggestion for a combobox means the typed text is NOT a value the
        // ATS accepts. Leaving it there reads as filled to us and as empty to
        // them; gap it honestly instead.
        if (required) unresolved.push({ q: labelText.slice(0, 200), options: [], required: true, combo: 1 });
      }
    }
  }
  if (__sweep === 0) { const __n = await pg.locator('input:visible, textarea:visible').count().catch(() => 0); if (!__n) break; }
  }
  // Two sweeps means a field that gaps on both is pushed twice - dedupe on the
  // question text so gaps.jsonl and the needs-inference count stay honest.
  {
    const seen = new Set();
    return unresolved.filter(u => { const k = String(u.q || ''); if (seen.has(k)) return false; seen.add(k); return true; });
  }
}
async function fillSelects(pg) {
  const unresolved = [];
  // Country FIRST, then wait. On Phenom (GE, CAI, Cisco, Battelle) Country
  // defaults to "United States of America" and the dependent "State*" select
  // (US states only) re-renders as "Province or Territory*" with Ontario only
  // after Country changes. The main loop reached State in the same pass and
  // read the stale US list, gapping it and leaving Next disabled on the whole
  // family (live probe 2026-09-24). Exact "Canada" option only - a phone-code
  // select ("Canada (+1)") is not a Country field.
  let countryChanged = false;
  for (const sel of await pg.locator('select:visible').all()) {
    const r = await sel.evaluate(e => {
      const lab = ((e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.innerText) || e.getAttribute('aria-label') || e.name || e.id || '');
      if (!/country/i.test(lab) || /work|employ|authori|sponsor|office|prefer|interest|relocat|phone/i.test(lab)) return null;
      const o = [...e.options].find(x => x.text.trim() === 'Canada');
      return o && e.options[e.selectedIndex]?.text.trim() !== 'Canada' ? o.value : null;
    }).catch(() => null);
    if (r !== null && r !== undefined) { if (await sel.selectOption(r).then(() => true).catch(() => false)) countryChanged = true; }
  }
  if (countryChanged) await pg.waitForTimeout(3000);
  // A US-only State list can't express an Ontario address (never-answer), but
  // the JobRight extension picks one anyway: Battelle read State*=AR next to
  // Country*=Canada (2026-09-24). Reset it to the placeholder and gap it.
  // A wrong state on a real application is worse than a blocked one.
  for (const sel of await pg.locator('select:visible').all()) {
    const bad = await sel.evaluate(e => {
      const lab = ((e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.innerText) || e.getAttribute('aria-label') || e.name || e.id || '').replace(/\s+/g, ' ').trim();
      if (!/\b(state|province)\b/i.test(lab) || /united states|country|status|statement/i.test(lab)) return null;
      const canada = [...document.querySelectorAll('select')].some(s => /country/i.test((s.id && document.querySelector(`label[for="${CSS.escape(s.id)}"]`)?.innerText) || s.name || s.id || '') && s.options[s.selectedIndex]?.text.trim() === 'Canada');
      const texts = [...e.options].map(o => o.text.trim());
      if (!canada || e.selectedIndex <= 0 || texts.some(t => /^(ontario|on)$/i.test(t))) return null;
      if (!texts.some(t => /^(AL|AK|AZ|CA|NY|TX|Alabama|Alaska|California|Texas)$/.test(t))) return null;
      const was = texts[e.selectedIndex]; e.selectedIndex = 0; e.dispatchEvent(new Event('change', { bubbles: true }));
      return { lab, was, opts: texts.slice(0, 6) };
    }).catch(() => null);
    if (bad) unresolved.push({ q: bad.lab.slice(0, 140), options: bad.opts, required: true, mismatch: 'us-state-vs-ontario', was: bad.was });
  }
  for (const sel of await pg.locator('select:visible').all()) {
    const opts = await sel.locator('option').evaluateAll(o => o.map(x => x.innerText).filter(Boolean));
    const m = await sel.evaluate((e, a) => { eval(a.lbl);
      return { l: QUP(e, a.opts) || LBL(e), v: e.value || '',
               sl: ((e.options || [])[e.selectedIndex] || {}).text || '',
               req: !!(e.required || e.getAttribute('aria-required') === 'true') };
    }, { lbl: LBL_SRC, opts }).catch(() => null);
    if (!m) continue;
    // The JobRight extension pre-fills most selects correctly, but has been
    // observed defaulting Country to "United States" regardless of the bank's
    // real country. Normally an already-filled field is left alone (don't
    // clobber a good extension fill) - but a wrong country on your OWN
    // address is a visible inconsistency worth actively correcting, not just
    // a missed autofill. Only country gets this override.
    const isCountry = /country/i.test(m.l || '');
    const countryWrong = isCountry && m.v && !/canada/i.test(m.v) && opts.some(o => /canada/i.test(o));
    // Same class as the Country override, found via shadow.jsonl: the extension
    // pre-filled "How did you hear about us?" as "Print Advertisement" (RTX) -
    // which is simply FALSE - and "Other" (CAI). We have a confident learned
    // answer and the option exists on both forms, so correct it rather than let
    // a false statement stand. Compare SELECTED LABEL, not e.value: the value is
    // an internal token ("REC_Print Advertisement") that never matches a label.
    // Bare "Source*" (Toyota/Phenom) is the same question under another name.
    const isSource = /how did you (hear|find out) about/i.test(m.l || '') || /^\W*(applicant |candidate |job |recruitment )?source\b/i.test(m.l || '');
    // Only a REAL LinkedIn option. A Phenom parent "How did you hear" list
    // has none, fuzzyOpt settled on some other category, and this override
    // flipped our "Website" away on the next pass - so the dependent Source
    // list never loaded (Excellus/Univera/MITRE, verified live 2026-09-25).
    const srcFz = isSource ? fuzzyOpt(opts.map(o => String(o).trim()).filter(Boolean), 'LinkedIn') : null;
    const srcWant = srcFz && /linked ?in/i.test(srcFz) ? srcFz : null;
    const sourceWrong = !!srcWant && !!m.v && String(m.sl || '').trim().toLowerCase() !== srcWant.trim().toLowerCase();
    if (sourceWrong) { await sel.selectOption({ label: srcWant }).catch(() => {}); continue; }
    if (m.v && !countryWrong) continue;
    // grad year: a year list normally carries a placeholder ("Select...") and/or
    // "Other" alongside the years - ignore those instead of failing the test.
    const real = opts.map(o => String(o).trim()).filter(Boolean)
      .filter(o => !/^(select|choose|--|please)/i.test(o) && !/^other$/i.test(o));
    // Exactly one real choice carries no information and cannot be wrong -
    // but leaving it blank blocks submission. Seen constantly as a required
    // "Country" whose only option is the employer's own country.
    if (real.length === 1) { await sel.selectOption({ label: real[0] }).catch(() => {}); continue; }
    const yrs = real.map(Number).filter(y => y >= 2015 && y <= 2035);
    if (yrs.length >= 3 && yrs.length === real.length) {
      // A bare year list is ambiguous: "Year of High School Graduation" and
      // "intended graduation year" are BOTH all-years. Defaulting every one to
      // the degree year (2028) puts false info on the form, so classify first
      // and leave it as a gap when the question does not say which year it wants.
      const q = (m.l || '').toLowerCase();
      let target = null;
      if (/high school|secondary school|hs grad/.test(q)) target = YEARS.highschool;
      else if (/graduat|completion|degree|program|expected/.test(q)) target = YEARS.degree;
      if (target === null) {
        if (m.req || reqFromText(m.l)) unresolved.push({ q: (m.l || '(unlabeled year list)').slice(0, 140), options: real.slice(0, 30), required: true });
        continue;
      }
      const want = yrs.includes(target) ? target : Math.max(...yrs.filter(y => y <= target));
      if (want) { await sel.selectOption({ label: String(want) }).catch(() => {}); continue; }
    }
    const choice = infer(m.l, opts);
    if (choice) {
      // selectOption({label}) is an EXACT match, and the option text we read via
      // innerText is trimmed/collapsed while the DOM label may carry leading
      // whitespace or a nbsp - so a correct answer could throw and the old
      // .catch(() => {}) threw the evidence away with it. Freddie Mac's
      // "How did you hear about us?*" offered LinkedIn, infer returned LinkedIn,
      // and the field still came out empty post-fill. Retry against the option's
      // real text, then record the failure instead of swallowing it.
      let selErr = await sel.selectOption({ label: choice }).then(() => null).catch(e => String(e.message || e));
      if (selErr) {
        const idx = await sel.evaluate((e, want) => {
          const norm = t => String(t).replace(/\s+/g, ' ').trim().toLowerCase();
          const i = [...e.options].findIndex(o => norm(o.text) === norm(want));
          return i;
        }, choice).catch(() => -1);
        if (idx >= 0) selErr = await sel.selectOption({ index: idx }).then(() => null).catch(e => String(e.message || e));
      }
      if (selErr && (m.req || reqFromText(m.l)))
        unresolved.push({ q: m.l.slice(0, 140), options: opts.filter(o => o.trim()).slice(0, 30), required: true, selErr: selErr.slice(0, 90), wanted: String(choice).slice(0, 60) });
    }
    else if (m.req || reqFromText(m.l)) unresolved.push({ q: m.l.slice(0, 140), options: opts.filter(o => o.trim()).slice(0, 30), required: true });
  }
  return unresolved;
}
async function fillRadios(pg) {
  const unresolved = [];
  let radioEscalations = 0;   // bound the fix-51 re-click cost per form
  const groups = await pg.evaluate(lbl => {
    eval(lbl);
    const byName = {};
    // Group key per radio. Gem renders Yes/No radios with ids but NO name
    // attribute; keying on r.name alone made every one of them invisible and
    // the submit failed "Please select an option." x6 (23 Gem records,
    // 2026-09-24). Nameless radios group by their nearest ancestor holding 2+
    // radios. Every group is then addressed by data-ja-grp, never by name.
    const anc = new Map(), names = new Map();
    const keyOf = r => {
      if (r.name) { if (!names.has(r.name)) names.set(r.name, 'n' + names.size); return names.get(r.name); }
      let n = r.parentElement; while (n && n.querySelectorAll('input[type=radio]').length < 2) n = n.parentElement;
      if (!n) return null;
      if (!anc.has(n)) anc.set(n, 'a' + anc.size); return anc.get(n);
    };
    document.querySelectorAll('input[type=radio]').forEach(r => {
      const gk = keyOf(r); if (!gk) return;
      r.dataset.jaGrp = gk;
      // Ashby (and other React ATSs) render radio options with NO id, NO
      // wrapping <label>, value="on" for every option, and the visible option
      // text in a SIBLING node. Both of the old label sources come back empty,
      // so every option label was '' - infer() received ["","","",""], could
      // never match an answer, and every Ashby radio question was
      // structurally unanswerable. Widen the label search the same way LBL()
      // already does for text inputs.
      const clean = t => (t || '').replace(/\s+/g, ' ').trim();
      let lb = (r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.innerText) || r.closest('label')?.innerText || '';
      if (!clean(lb)) { const ab = r.getAttribute('aria-labelledby'); if (ab) lb = document.getElementById(ab)?.innerText || ''; }
      if (!clean(lb)) lb = r.getAttribute('aria-label') || '';
      // the option wrapper: nearest ancestor whose text is short and is NOT
      // shared with a sibling radio (i.e. it wraps exactly this one input).
      if (!clean(lb)) {
        let n = r.parentElement, h = 0;
        while (n && h++ < 4) {
          const t = clean(n.innerText);
          if (t && t.length < 120 && n.querySelectorAll('input[type=radio]').length === 1) { lb = t; break; }
          n = n.parentElement;
        }
      }
      if (!clean(lb)) lb = clean(r.nextElementSibling?.innerText || '');
      if (!clean(lb) && r.value && r.value !== 'on') lb = r.value;
      (byName[gk] ||= []).push({ id: r.id, checked: r.checked || r.closest('[role=radio]')?.getAttribute('aria-checked') === 'true', value: r.value, label: clean(lb), aria: !!r.closest('[role=radio]') });
    });
    const out = [];
    for (const [name, opts] of Object.entries(byName)) {
      if (opts.some(o => o.checked)) continue;
      const first = document.querySelector(`input[data-ja-grp="${name}"]`);
      let q = first ? QUP(first, opts.map(o => o.label)) : '';
      // No visible question text at all: fall back to a descriptive input name.
      // Paycom's SMS opt-in is two bare "Yes"/"No" radios whose only clue is
      // name="candidate-primary-phone-message-opt-in-field" (23 empty-label
      // Yes/No gaps across Paycom/Ashby/Lever, 2026-09-25). UUID-ish names
      // carry nothing and are ignored.
      if (!q.trim() && first?.name && /[a-z]{3,}[-_][a-z]{3,}/i.test(first.name) && !/^[0-9a-f-]{20,}$/i.test(first.name))
        q = first.name.replace(/[-_]+/g, ' ').replace(/\b(field|input|radio|candidate)\b/gi, '');
      out.push({ name, q: q.replace(/\s+/g, ' ').trim().slice(0, 250), opts });
    }
    return out;
  }, LBL_SRC).catch(() => []);
  for (const g of groups) {
    const choice = infer(g.q, g.opts.map(o => o.label));
    if (!choice) { unresolved.push({ q: g.q.slice(0, 140), options: g.opts.map(o => o.label).slice(0, 30), required: reqFromText(g.q) }); continue; }
    let idx = g.opts.findIndex(o => o.label === choice);
    if (idx < 0) idx = g.opts.findIndex(o => nkey(o.label) === nkey(choice));
    if (idx < 0) { unresolved.push({ q: g.q.slice(0, 140), options: g.opts.map(o => o.label).slice(0, 30), required: reqFromText(g.q) }); continue; }
    const t = g.opts[idx];
    let done = false;
    // ARIA radios first-try the only strategy that works on them; the chain
    // below burned 3 x 2.5s failed attempts per Rippling group (2026-09-24).
    if (t.aria) done = await pg.locator(`input[type=radio][data-ja-grp="${g.name}"]`).nth(idx)
      .locator('xpath=ancestor::*[@role="radio"][1]').click({ timeout: 2500 }).then(() => true).catch(() => false);
    if (!done && t.id) done = await pg.locator(`#${t.id.replace(/([:.\[\],])/g, '\\$1')}`)
      .check({ timeout: 2500 }).then(() => true).catch(() => false);
    if (!done) {                                  // no id: address by name + position
      const sel = `input[type=radio][data-ja-grp="${g.name}"]`;
      const radio = pg.locator(sel).nth(idx);
      done = await radio.check({ timeout: 2500, force: true }).then(() => true).catch(() => false);
      // Custom-styled radios (Paylocity et al.) render the real input as a
      // zero-size/hidden node with a sibling doing the visible rendering.
      // .check() can silently no-op on these even with force - a real user
      // would click the LABEL, not the invisible input, so try that too.
      if (!done) done = await radio.locator('xpath=ancestor::label[1]').click({ timeout: 2500, force: true })
        .then(() => true).catch(() => false);
      // ARIA radios (Rippling): <div role=radio> wraps a zero-size input with
      // no <label>. Only the role=radio element takes the click (live probe
      // 2026-09-24: input "not visible", div click -> aria-checked=true).
      if (!done) done = await radio.locator('xpath=ancestor::*[@role="radio"][1]').click({ timeout: 2500 })
        .then(() => true).catch(() => false);
      // Last resort: a trusted click directly on the input itself (distinct
      // from .check(), which also verifies the resulting checked state -
      // that verification is what was failing on a React-controlled input
      // whose checked attribute the framework does not mirror natively).
      if (!done) done = await radio.click({ timeout: 2500, force: true }).then(() => true).catch(() => false);
    }
    // A reported success is not a committed answer. Huawei/Recruitee logged NO
    // gap for "Are you open to work fully onsite? * Yes No" - infer answered it
    // "Yes" from learned.json - and the post-submit diag still listed it under
    // blanks with "This field is required". So the FIRST strategy (#id .check())
    // returned true while the framework re-rendered and dropped it. Verify the
    // group is actually checked, and if not, run the remaining strategies even
    // though the earlier one claimed to have worked.
    const grpSel = `input[type=radio][data-ja-grp="${g.name}"]`;
    const isChecked = async () => pg.evaluate(sel =>
      [...document.querySelectorAll(sel)].some(r => r.checked || r.closest('[role=radio]')?.getAttribute('aria-checked') === 'true'), grpSel).catch(() => false);
    if (done && !(await isChecked()) && radioEscalations < 8) {
      radioEscalations++;
      const radio = pg.locator(grpSel).nth(idx);
      await radio.locator('xpath=ancestor::label[1]').click({ timeout: 1200, force: true }).catch(() => {});
      if (!(await isChecked())) await radio.click({ timeout: 1200, force: true }).catch(() => {});
      if (!(await isChecked())) {
        await radio.evaluate(r => { r.click(); }).catch(() => {});
        await pg.waitForTimeout(200);
      }
      done = await isChecked();
    }
    if (!done) unresolved.push({ q: g.q.slice(0, 140), options: g.opts.map(o => o.label).slice(0, 30), required: reqFromText(g.q) });
  }
  return unresolved;
}
// Standalone required checkboxes ("I have read and agree to the Privacy
// policy and Terms of use", background-check consent, etc.) were never
// touched anywhere - fillText() explicitly skips type=checkbox, fillSelects()
// only sees <select>, fillRadios() only sees input[type=radio]. This silently
// produced 'submit-unconfirmed' on WEX (careers.wexinc.com) with the ATS's
// own validator surfacing "Please accept all the required consents". Treat
// each unchecked checkbox as a Yes/No question so EEO/decline polarity still
// applies via infer() - never blindly check every box.
// A REQUIRED GROUP of checkboxes under one question ("Which office are you
// applying to? (Select both if appropriate)" on Ashby, "Language Skill(s)
// (Check all that apply) \u2731" on Lever) is a distinct control from a lone
// consent checkbox, and nothing handled it: fillCheckboxes() asks Yes/No about
// each option's own label in isolation ("San Francisco HQ - 181 Fremont
// Street"), which is not a yes/no question and always resolved to null. The
// group question plus its option list is the answerable unit - same shape as a
// radio group, so treat it like one.
async function fillCheckboxGroups(pg) {
  const unresolved = [];
  const groups = await pg.evaluate(lbl => {
    eval(lbl);
    const clean = t => (t || '').replace(/\s+/g, ' ').trim();
    const vis = e => e.offsetWidth > 0 || e.offsetHeight > 0;
    const seen = new Set(), out = [];
    const boxes = [...document.querySelectorAll('[data-field-entry-id], fieldset, [class*=question i], [class*=field i], [role=group]')];
    for (const box of boxes) {
      const cbs = [...box.querySelectorAll('input[type=checkbox]')].filter(vis);
      if (cbs.length < 2) continue;                       // a lone checkbox is a consent, not a group
      if (cbs.some(c => c.checked)) continue;             // already answered
      if (cbs.some(c => seen.has(c))) continue;           // an outer container already claimed these
      // take the INNERMOST container holding exactly this set
      if (box.querySelector('[data-field-entry-id], fieldset, [role=group]') &&
          [...box.querySelectorAll('[data-field-entry-id], fieldset, [role=group]')].some(inner =>
            [...inner.querySelectorAll('input[type=checkbox]')].filter(vis).length === cbs.length)) continue;
      const opts = cbs.map(c => {
        let l = (c.id && document.querySelector(`label[for="${CSS.escape(c.id)}"]`)?.innerText) || c.closest('label')?.innerText || '';
        if (!clean(l)) l = c.getAttribute('aria-label') || '';
        if (!clean(l)) {
          let n = c.parentElement, h = 0;
          while (n && h++ < 4) { const t = clean(n.innerText); if (t && t.length < 140 && n.querySelectorAll('input[type=checkbox]').length === 1) { l = t; break; } n = n.parentElement; }
        }
        if (!clean(l)) l = clean(c.nextElementSibling?.innerText || '');
        return clean(l);
      });
      if (opts.filter(Boolean).length < 2) continue;
      if (opts.some(o => /cookie/i.test(o))) continue;
      const q = QUP(cbs[0], opts) || clean(box.innerText);
      cbs.forEach((c, i) => { seen.add(c); c.setAttribute('data-ja-group', '1'); c.setAttribute('data-ja-idx', String(i)); });
      out.push({ q: clean(q).slice(0, 250), opts, multi: /select all|check all|all that apply|select both|choose all/i.test(clean(box.innerText)) });
    }
    return out;
  }, LBL_SRC).catch(() => []);
  for (const g of groups) {
    // "Which offices would you be willing to work from/relocate to? Select
    // all that apply" - answers.json relocate:true makes EVERY office true.
    // infer() returns one option, so this multi-select gapped (Shield AI).
    if (g.multi && FACTS?.relocate === true && /(willing|open|able) to (work|relocate)|relocate to|which .{0,20}(office|location)/i.test(g.q)) {
      const idxs = g.opts.map((o, i) => [o, i]).filter(([o]) => o.trim() && !/none|other|remote|not willing|prefer not/i.test(o)).map(([, i]) => i);
      let ok = 0;
      for (const i of idxs) {
        const cb = pg.locator(`input[type=checkbox][data-ja-group="1"][data-ja-idx="${i}"]`).first();
        if (await cb.check({ timeout: 2500, force: true }).then(() => true).catch(() => false)
            || await cb.locator('xpath=ancestor::label[1]').click({ timeout: 2000, force: true }).then(() => true).catch(() => false)) ok++;
      }
      if (ok) continue;
    }
    // "What technology stack do you have experience with?" (Lever checkboxes,
    // Quest Analytics 2026-09-24): check exactly the options that name a skill
    // in FACTS.skills. Exact token match only - SQL/Azure/JavaScript are not
    // claimed from PostgreSQL/-/TypeScript.
    if (FACTS?.skills && /technolog|tech(nical)? stack|programming languages?|languages? .{0,25}(experience|proficien|familiar)|(tools|frameworks|languages).{0,40}(experience|worked with|used)|experience with (the following|any of)/i.test(g.q)) {
      const sk = t => String(t).toLowerCase().replace(/\.js\b/g, '').replace(/[^a-z0-9+#]+/g, ' ').trim();
      const SK = new Set(String(FACTS.skills).split(/,/).map(sk).filter(Boolean));
      const idxs = g.opts.map((o, i) => [o, i]).filter(([o]) => String(o).split(/[,/&]| and /).map(sk).some(t => t && SK.has(t))).map(([, i]) => i);
      let ok = 0;
      for (const i of idxs) {
        const cb = pg.locator(`input[type=checkbox][data-ja-group="1"][data-ja-idx="${i}"]`).first();
        if (await cb.check({ timeout: 2500, force: true }).then(() => true).catch(() => false)
            || await cb.locator('xpath=ancestor::label[1]').click({ timeout: 2000, force: true }).then(() => true).catch(() => false)) ok++;
      }
      if (ok) { ANS_LOG.push(`${g.q.slice(0, 70)} => [${idxs.map(i => g.opts[i]).join(', ').slice(0, 80)}]`); continue; }
    }
    const choice = infer(g.q, g.opts);
    if (!choice) { unresolved.push({ q: g.q.slice(0, 200), options: g.opts.slice(0, 30), required: reqFromText(g.q), group: 1 }); continue; }
    const idx = g.opts.findIndex(o => o === choice) >= 0 ? g.opts.findIndex(o => o === choice)
              : g.opts.findIndex(o => nkey(o) === nkey(choice));
    if (idx < 0) { unresolved.push({ q: g.q.slice(0, 200), options: g.opts.slice(0, 30), required: reqFromText(g.q), group: 1 }); continue; }
    const cb = pg.locator(`input[type=checkbox][data-ja-group="1"][data-ja-idx="${idx}"]`).first();
    let done = await cb.check({ timeout: 2500, force: true }).then(() => true).catch(() => false);
    if (!done) done = await cb.locator('xpath=ancestor::label[1]').click({ timeout: 2000, force: true }).then(() => true).catch(() => false);
    if (!done) done = await cb.click({ timeout: 2000, force: true }).then(() => true).catch(() => false);
    if (!done) unresolved.push({ q: g.q.slice(0, 200), options: g.opts.slice(0, 30), required: reqFromText(g.q), group: 1, clickFailed: 1 });
  }
  return unresolved;
}
async function fillCheckboxes(pg) {
  const unresolved = [];
  // Not :visible - Ashby's "I Acknowledge" box (age-redaction notice) is a
  // hidden input under a styled span, so :visible skipped it and the form was
  // refused "Missing entry for required field" (Snowflake, 2026-09-25). Keep a
  // hidden input only when its own <label for=id> is visible; Ashby's Yes/No
  // widgets carry id-less hidden checkboxes and stay with fillYesNo().
  for (const el of await pg.locator('input[type=checkbox]:not([data-ja-group])').all()) {
    const m = await el.evaluate((e, lbl) => { eval(lbl);
      const shown = x => { if (!x) return false; const r = x.getBoundingClientRect(), cs = getComputedStyle(x); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const forLbl = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`) : null;
      const vis = shown(e) ? 'input' : shown(forLbl) ? 'label' : null;
      return { vis, checked: e.checked, required: !!(e.required || e.getAttribute('aria-required') === 'true'), label: LBL(e) };
    }, LBL_SRC).catch(() => null);
    if (!m || !m.vis || m.checked || !m.label) continue;
    if (/cookie/i.test(m.label)) continue;      // cookie-consent widgets, not the application
    const choice = infer(m.label, ['Yes', 'No']);
    if (choice === 'Yes') {
      // Same class of bug fillRadios() already works around: a custom-styled
      // checkbox can render its real input as zero-size/hidden with a sibling
      // doing the visible rendering, so .check() silently no-ops even with
      // force. Confirmed live on WEX's own consent checkbox - passed on one
      // visit, silently failed on a later one with no code change. Fall
      // through to clicking the label, then a trusted click on the input.
      // A hidden input only takes a click through its visible label (React state).
      let done = m.vis === 'label'
        ? await pg.locator(`label[for="${(await el.getAttribute('id')).replace(/"/g, '\\"')}"]`).first().click({ timeout: 2500 }).then(() => el.isChecked()).catch(() => false)
        : false;
      if (!done) done = await el.check({ timeout: 2500, force: true }).then(() => true).catch(() => false);
      if (!done) done = await el.locator('xpath=ancestor::label[1]').click({ timeout: 2500, force: true })
        .then(() => true).catch(() => false);
      if (!done) done = await el.click({ timeout: 2500, force: true }).then(() => true).catch(() => false);
      if (!done) unresolved.push({ q: m.label.slice(0, 140), options: ['Yes', 'No'], required: m.required || reqFromText(m.label) });
    } else if (choice === null && m.required) {
      unresolved.push({ q: m.label.slice(0, 140), options: ['Yes', 'No'], required: m.required || reqFromText(m.label) });
    }
  }
  return unresolved;
}
// Ashby renders Yes/No questions (ITAR/export-control, "comfortable with
// nights and weekends", etc.) as a pair of <button class="...yesno-option">
// elements, not native radio inputs - fillRadios()'s input[type=radio] query
// sees nothing. Confirmed live on jobs.ashbyhq.com: 0 radio inputs on a page
// with 3 unanswered Yes/No questions, each scoped to a stable
// data-field-entry-id wrapper.
async function fillYesNo(pg) {
  const unresolved = [];
  const groups = await pg.evaluate(lbl => {
    eval(lbl);
    const out = [];
    document.querySelectorAll('[data-field-entry-id]').forEach(entry => {
      const btns = [...entry.querySelectorAll('button')].filter(b => /^(yes|no)$/i.test((b.innerText || '').trim()));
      if (btns.length < 2) return;
      const answered = btns.some(b => b.getAttribute('aria-pressed') === 'true' || /selected|active|_checked/i.test(b.className));
      if (answered) return;
      const opts = btns.map(b => b.innerText.trim());
      const q = QUP(btns[0], opts) || LBL(btns[0]) || (entry.querySelector('label')?.innerText || '');
      out.push({ entryId: entry.getAttribute('data-field-entry-id'), q: q.replace(/\s+/g, ' ').trim().slice(0, 250), opts });
    });
    return out;
  }, LBL_SRC).catch(() => []);
  for (const g of groups) {
    const choice = infer(g.q, g.opts);
    if (!choice) { unresolved.push({ q: g.q.slice(0, 140), options: g.opts.slice(0, 30), required: reqFromText(g.q) }); continue; }
    const scope = `[data-field-entry-id="${g.entryId}"]`;
    const btn = pg.locator(`${scope} button`, { hasText: new RegExp(`^${choice}$`, 'i') }).first();
    const pressed = async () => await pg.locator(`${scope} button`).evaluateAll(
      (ns, want) => ns.some(n => (n.innerText || '').trim().toLowerCase() === want.toLowerCase()
        && (n.getAttribute('aria-pressed') === 'true' || /selected|active|_checked/i.test(n.className))),
      choice).catch(() => false);
    await btn.click({ timeout: 2500 }).catch(() => {});
    let done = await pressed();
    if (!done) { await btn.click({ timeout: 2500, force: true }).catch(() => {}); done = await pressed(); }
    if (!done) {
      // The visible button is a sibling of a real 0x0 <input type=checkbox>
      // that holds the actual value. Drive that directly.
      const idx = g.opts.findIndex(o => String(o).trim().toLowerCase() === choice.toLowerCase());
      if (idx >= 0) {
        const cbx = pg.locator(`${scope} input[type=checkbox]`).nth(idx);
        if (await cbx.count().catch(() => 0)) await cbx.check({ timeout: 2000, force: true }).catch(() => {});
        done = await pressed();
        if (!done) { await cbx.click({ timeout: 2000, force: true }).catch(() => {}); done = await pressed(); }
      }
    }
    if (!done) { await btn.evaluate(e => e.click()).catch(() => {}); done = await pressed(); }
    if (!done) unresolved.push({ q: g.q.slice(0, 140), options: g.opts.slice(0, 30), required: reqFromText(g.q), clickFailed: 1 });
  }
  return unresolved;
}
// Custom comboboxes (React-Select / Oracle Cloud / Ashby location pickers):
// no native <select>, no native radio, and the options do not exist in the
// DOM until the widget is opened. fillSelects() and fillRadios() are both
// blind to them, which is why every *.oraclecloud.com job in the ledger
// gapped. Conservative by design: only touches a widget that still shows a
// placeholder, and only after the opened widget actually renders options.
const COMBO = process.env.COMBO !== '0';
// `tab` is reassigned to a Frame whenever the real form turns out to be inside
// an iframe (careerpuck -> Greenhouse, iCIMS, Lyft). A Playwright Frame has
// locator()/evaluate()/waitForTimeout() but NO .keyboard - that lives on the
// Page. Calling pg.keyboard.press() on a Frame threw
// "Cannot read properties of undefined (reading 'press')", which the job-level
// catch turned into an opaque err:* and lost the job.
const kbHost = pg => (pg && pg.keyboard ? pg : (pg && typeof pg.page === 'function' ? pg.page() : null));
const pressEsc = async pg => { const h = kbHost(pg); if (h && h.keyboard) await h.keyboard.press('Escape').catch(() => {}); };
async function fillComboboxes(pg) {
  const unresolved = [];
  if (!COMBO) return unresolved;
  const boxes = await pg.locator('[role=combobox]:visible, input[aria-autocomplete="list"]:visible, [class*="select__control"]:visible').all().catch(() => []);
  // Paylocity renders a div[role=combobox] for country/state/county in EVERY
  // address block (applicant + one per work-history row) plus the yes/no
  // questions, so the required SMS-consent combobox sat past index 20 and was
  // never reached - the whole wizard stayed blocked on a field we could answer.
  let __ct = null;
  for (const cb of boxes.slice(0, 45)) {
    if (process.env.DEBUG_TIME && __ct) { const d = Date.now() - __ct.t; if (d > 3000) console.error(`[slowcombo] ${d}ms ${__ct.l}`); }
    __ct = { t: Date.now(), l: '?' };
    const m = await cb.evaluate((e, lbl) => { eval(lbl);
      const host = e.closest('[class*=select i],[class*=combobox i],[role=combobox]') || e.parentElement;
      const shown = ((e.value || '') + ' ' + (host ? host.innerText : '')).replace(/\s+/g, ' ').trim();
      // A placeholder is the ONLY state we are willing to touch - anything
      // else may be a value the extension already filled correctly.
      // ...but "Choose not to disclose" / "Select prefer not to say" are real
      // answers that merely START like a placeholder. Reading them as empty
      // re-did every EEO combo on every pass (~10-15s each on Rippling).
      const empty = !shown || shown.length < 2 || (/^(select|choose|--+|please select|search|start typing|type to search|\.\.\.)/i.test(shown)
        && !/disclos|declin|prefer not|not to (say|answer|identify)|wish to/i.test(shown));
      // A div[role=combobox] has no <label for>, so the nearest non-empty text
      // is often the widget's OWN placeholder ('--'), not the question. That
      // made infer() try to answer the literal string '--' and decline, which
      // is why Paylocity's SMS-consent question stayed empty and blocked the
      // whole wizard. Climb until a real question appears.
      let l = (QUP(e, []) || LBL(e) || '').slice(0, 220);
      if (!l || /^[-\u2014\s]+$/.test(l) || l.length < 12 || l === shown
          || /^(select|choose|please select|search|start typing|type to search)/i.test(l)) {
        // The field's own wrapper label first (Ashby data-field-entry-id,
        // fieldset legend). The blind climb below reached the whole FORM on
        // Ashby - "Full Name Email ... Resume ..." - and a majors list with
        // "Computer Science" in it gapped (Snowflake, 2026-09-25).
        const wrap = e.closest('[data-field-entry-id], [data-field-path], fieldset');
        const wl = (wrap?.querySelector('label, legend')?.innerText || '').replace(/\s+/g, ' ').trim();
        if (wl.length >= 3 && wl !== shown) l = wl.slice(0, 220);
        else {
          let n = e.parentElement, h = 0;
          while (n && h++ < 6) {
            const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
            if (t.length > 400) break;   // climbed past the field into the form
            if (t.length >= 15 && !/^[-\u2014\s]+$/.test(t)) { l = t.slice(0, 220); break; }
            n = n.parentElement;
          }
        }
      }
      return { empty, l, shown: shown.slice(0, 60) };
    }, LBL_SRC).catch(() => null);
    if (process.env.DEBUG_COMBO) {
      const _id = await cb.evaluate(e => e.id || e.getAttribute('name') || e.className.slice(0,20)).catch(() => '?');
      console.error('[combo]', JSON.stringify({ id: _id, empty: m?.empty, shown: m?.shown, l: (m?.l || '').slice(0, 80) }));
    }
    if (m) __ct.l = `${m.empty ? 'EMPTY' : 'set'} ${String(m.l || '').slice(0, 50)} = ${m.shown}`;
    if (!m || !m.empty || !m.l) continue;
    if (/cookie/i.test(m.l)) continue;
    // No scroll + a 2.5s budget + a swallowed failure meant the click often
    // never opened the list, and the empty option list was then misread as
    // 'typeahead with no options'. Paylocity's required SMS-consent combobox
    // sits far down an 80-field form and failed here every time.
    await pressEsc(pg);   // a dropdown left open by the previous box leaks its options into this one
    await cb.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    if (!await cb.click({ timeout: 4000 }).then(() => true).catch(() => false))
      await cb.evaluate(e => e.click()).catch(() => {});
    await pg.waitForTimeout(1100);
    // Scope to the listbox that is actually open. The old page-wide query
    // accumulated options from every dropdown left open earlier in the pass -
    // observed live on Paylocity, where a COUNTRY field was offered
    // ["Yes","No","Yes*"] and was about to be answered "No".
    const readOpts = () => pg.evaluate(() => {
      const vis = e => e.getClientRects().length > 0;
      const lbs = [...document.querySelectorAll('[role=listbox]')].filter(vis);
      const scope = lbs.length ? lbs[lbs.length - 1] : null;
      const sel = '[role=option], [class*="select__option"], li[role=option]';
      const src = scope ? [...scope.querySelectorAll(sel)] : [...document.querySelectorAll(sel)].filter(vis);
      return src.filter(vis).map(n => (n.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 60);
    }).catch(() => []);
    let opts = await readOpts();
    // Ashby's "Start typing..." comboboxes open NO list on click, only on
    // ArrowDown or typing ("How did you hear about us?" blocked 11 Ashby
    // submits, 2026-09-24). Try ArrowDown before treating it as a typeahead.
    if (!opts.length) {
      const host = kbHost(pg);
      if (host) { await host.keyboard.press('ArrowDown').catch(() => {}); await pg.waitForTimeout(700); opts = await readOpts(); }
    }
    if (!opts.length) {
      // A location/school typeahead renders NO options until you type. The old
      // code escaped and left a REQUIRED field empty WITHOUT logging a gap -
      // Ashby then refused the form with 'Missing entry for required field:
      // Where are you currently located?' on 5 separate jobs. If the bank knows
      // the answer, type it and take the first suggestion.
      // learned.json / LLM answers too: "how did you hear" -> LinkedIn lives
      // in learned.json, and bankValue alone never seeded it.
      const lrn = Object.entries(LEARNED).find(([k]) => m.l.toLowerCase().includes(k.toLowerCase()));
      const seed = bankValue(m.l) || (lrn && learnedFreeText(m.l, lrn[1])) || llmGet(m.l);
      if (seed) {
        // cb.fill() throws "Element is not an <input>" on a div[role=combobox]
        // and the .catch swallowed it, so nothing was ever typed and the box
        // gapped even though bankValue had the answer (Freddie Mac "School or
        // University*"). Try the inner input, then real keystrokes.
        const short = String(seed).split(",")[0].trim() || String(seed);
        let typed = await cb.fill(short.slice(0, 60), { timeout: 2000 }).then(() => true).catch(() => false);
        if (!typed) {
          const inner = cb.locator("input").first();
          if (await inner.count().catch(() => 0))
            typed = await inner.fill(short.slice(0, 60), { timeout: 2000 }).then(() => true).catch(() => false);
        }
        if (!typed) {
          await cb.click({ timeout: 2000 }).catch(() => {});
          typed = await (kbHost(pg)?.keyboard?.type(short.slice(0, 60), { delay: 15 }) ?? Promise.reject())
            .then(() => true).catch(() => false);
        }
        await pg.waitForTimeout(1600);
        const picked = await pg.locator('[role=option]:visible, [class*="select__option"]:visible').first()
          .click({ timeout: 2500 }).then(() => true).catch(() => false);
        if (picked) { await pg.waitForTimeout(400); continue; }
      }
      await pressEsc(pg);
      unresolved.push({ q: m.l.slice(0, 140), options: [], combo: 1, required: reqFromText(m.l) });
      continue;
    }
    // '--' is Paylocity's placeholder OPTION. It survived this filter, so a
    // Yes/No question looked like a 3-way choice and infer() declined it,
    // leaving 'SMS permission required' as the last thing blocking the wizard.
    const uniq = [...new Set(opts)].filter(o => !/^(select|choose|no results|loading|please select|-{2,}|\u2014+)\s*$/i.test(o));
    const GEO_Q = /^(country|state|province|county|city|address|administrative area|united states|canada|select a state|zip|postal)\b/i;
    const YESNO_OPTS = uniq.length > 0 && uniq.length <= 4
      && uniq.every(o => /^(yes|no|yes\*|n\/a|prefer not|decline)/i.test(o));
    if (GEO_Q.test(m.l.trim()) && YESNO_OPTS) {
      await pressEsc(pg);
      unresolved.push({ q: m.l.slice(0, 140), options: uniq.slice(0, 30), combo: 1,
        required: reqFromText(m.l), mismatch: 'geo-label-yesno-options' });
      continue;
    }
    const choice = uniq.length === 1 ? uniq[0] : infer(m.l, uniq);
    if (process.env.DEBUG_COMBO) console.error('[combo-opts]', JSON.stringify({ l: (m.l||'').slice(0,70), uniq: uniq.slice(0,6), choice }));
    if (!choice) {
      await pressEsc(pg);
      unresolved.push({ q: m.l.slice(0, 140), options: uniq.slice(0, 30), combo: 1, required: reqFromText(m.l) });
      continue;
    }
    const opt = pg.locator('[role=option]:visible, [class*="select__option"]:visible', { hasText: new RegExp('^\\s*' + choice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i') }).first();
    let ok = await opt.click({ timeout: 2500 }).then(() => true).catch(() => false);
    if (!ok) {   // type-ahead widgets only render the option after filtering
      await cb.fill(choice.slice(0, 40), { timeout: 2000 }).catch(() => {});
      await pg.waitForTimeout(1200);
      ok = await pg.locator('[role=option]:visible, [class*="select__option"]:visible').first()
        .click({ timeout: 2500 }).then(() => true).catch(() => false);
    }
    if (!ok) { await pressEsc(pg); unresolved.push({ q: m.l.slice(0, 140), options: uniq.slice(0, 30), combo: 1, required: reqFromText(m.l) }); }
    await pg.waitForTimeout(400);
  }
  if (process.env.DEBUG_TIME && __ct) { const d = Date.now() - __ct.t; if (d > 3000) console.error(`[slowcombo] ${d}ms ${__ct.l} (last)`); }
  return unresolved;
}
let FILE_LOG = [];
async function fillFiles(pg) {
  for (const f of await pg.locator('input[type=file]').all()) {
    // e.files.length is 0 on a drag-and-drop widget that already holds a file
    // in its own JS state (the JobRight extension having just uploaded one is
    // the common case). Adding a second then trips the widget's own limit -
    // "Too many files for this upload" - and the ATS refuses the whole
    // submission. Check what the widget is DISPLAYING, not just the input.
    const state = await f.evaluate(e => {
      const n = e.files ? e.files.length : 0;
      // Narrow on purpose: skipping a resume upload that was NOT actually
      // attached is far more expensive than one "too many files" rejection.
      // Only treat the widget as already-loaded when it shows BOTH a filename
      // and a remove/delete affordance next to it, within the small wrapper.
      let box = '', p = e.parentElement, h = 0;
      while (p && h++ < 3) { const t = (p.innerText || '').replace(/\s+/g, ' ').trim(); if (t && t.length < 220) box = t; p = p.parentElement; }
      const has = /\.(pdf|docx?|rtf|txt)\b/i.test(box) && /\b(remove|delete|replace|clear|×)\b/i.test(box);
      const prompt = /\b(attach|upload|drag)\b/i.test(box) && !/\.(pdf|docx?|rtf|txt)\b/i.test(box);
      return { n, has, prompt };
    }).catch(() => ({ n: 0, has: false, prompt: false }));
    // state.n alone is not proof of an upload: on Lever the extension sets
    // input.files but the widget never registers it, still reads "ATTACH
    // RESUME/CV", and the submit is refused (8 records with files=null and that
    // exact blank, 2026-09-23). Trust n only if the widget is not still
    // showing an empty-upload prompt with no filename.
    if (state.has) continue;
    if (state.n && !state.prompt) continue;
    const lab = await f.evaluate(e => {            // NO truncation: transcript labels run long
      let l = ''; if (e.id) { const x = document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if (x) l = x.innerText; }
      l = (l || e.closest('label')?.innerText || e.name || '').replace(/\s+/g, ' ').trim();
      // A generic widget caption ("Drop or select (.doc / .docx / .pdf)" on
      // Rippling) says nothing about WHICH document. Take the nearest wrapper
      // whose text says more - that is the field's own heading ("Résumé*",
      // "Cover letter"), found before climbing into a sibling field.
      // Gem: "Click to upload or drag and drop here" (23 unsubmitted records).
      if (!l || /^((click|tap)( here)? to )?(drop|select|upload|attach|browse|choose|drag)\b/i.test(l)) {
        let p = e.parentElement, h = 0;
        while (p && h++ < 6) {
          const t = (p.innerText || '').replace(/\s+/g, ' ').trim();
          // Phenom (Cisco) captions are "Upload from PC" / "Upload a file type
          // of DOC, DOCX, PDF..." - "from PC" is not a heading (2026-09-24).
          const rest = t.replace(/drop or select|drag and drop|choose file|browse|upload|attach|total \d+ files? selected|this field is required|\(\.[^)]*\)|[*\u2731]/gi, '')
            .replace(/\bfrom (my )?(pc|computer|device|desktop|google drive|drive|dropbox|one ?drive|box)\b|\b(a )?files? (type|format)s?( of)?\b|\b(max(imum)?|size|mb|kb|up to|or|and|only|accepted|supported|click|tap|here|to|drop|drag|a|your|file|files)\b|\b(pdf|docx?|rtf|txt|odt|png|jpe?g)\b/gi, '')
            .replace(/[^a-z\u00c0-\u024f]+/gi, ' ').trim();
          if (rest.length >= 3 && t.length < 260) { l = t; break; }
          p = p.parentElement;
        }
      }
      return l;
    }).catch(() => '');
    // Only resume.pdf and transcript.pdf exist. apply3 learned (09-22) never to
    // send the resume to a field asking for something else; offsite3 never got
    // that fix and uploaded the RESUME as Interplay's "Please take this test and
    // upload a screenshot" (2026-09-24). Allowlist: transcript -> transcript,
    // resume/CV or an unlabeled input (Ashby's main one) -> resume, else gap.
    // Ashby's "Autofill from resume" box is an optional parse helper, not the
    // Resume field. Uploading to it triggers an async re-parse that resets the
    // real Resume field after we have already judged it filled - 7 records
    // died "Missing entry for required field: Resume" with only this box in
    // their file log (2026-09-25). Never feed it.
    if (/^autofill from r[eé]sum[eé]/i.test(lab)) { FILE_LOG.push({ lab: lab.slice(0, 40), skipped: 'autofill-helper' }); continue; }
    const isTranscript = /transcript|academic record/i.test(lab);
    const isResume = !lab.trim() || /r[e\u00e9]sum[e\u00e9]|\bcv\b|curriculum vitae/i.test(lab);
    if (!isTranscript && !isResume) { FILE_LOG.push({ lab: lab.slice(0, 40), skipped: 'not-a-doc-we-have' }); continue; }
    const path = `${HOME}/.jobagent/${isTranscript ? 'transcript.pdf' : 'resume.pdf'}`;
    const err = await f.setInputFiles(path, { timeout: 12000 }).then(() => null).catch(e => String(e.message).slice(0, 70));
    const after = await f.evaluate(e => (e.files ? e.files.length : 0)).catch(() => 0);
    FILE_LOG.push({ lab: lab.slice(0, 40), err, after });
    // Ashby's 1x1 input is fed by a visible "Upload File" button; some widgets
    // only accept the file through that control. If the native set did not
    // take, drive the visible picker with a filechooser handler.
    if (!after) {
      const host = kbHost(pg);
      if (host) {
        const trigger = pg.locator('button:has-text("Upload"), button:has-text("Attach"), label:has-text("Upload")').first();
        if (await trigger.count().catch(() => 0)) {
          const fcP = host.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
          await trigger.click({ timeout: 4000 }).catch(() => {});
          const fc = await fcP;
          if (fc) { await fc.setFiles(path).catch(() => {}); FILE_LOG.push({ lab: 'via-filechooser', after: 1 }); }
        }
      }
    }
  }
}
// Consent banners sit fixed above the form and swallow the submit click.
// Some widgets (Securiti/CookieConsent) render the accept control as an <a>,
// not a <button> - a button-only selector list leaves the greyout overlay up
// forever and every click on the real page below silently no-ops.
async function dismissBanners(pg) {
  // Browser extensions (e.g. "Simplify Jobs") inject invisible shadow-root host
  // divs on top of Apply buttons across many ATS sites. Playwright correctly
  // refuses to click through them ("intercepts pointer events"), which silently
  // killed the reveal step. Neutralize hit-testing on these hosts - they render
  // nothing we need, so pointer-events:none is safe and doesn't touch real UI.
  // Corporate career sites commonly embed a live-chat widget (Phenom's
  // "phenom-chatbot-wrapper", bottom-right, opens itself and sits on top of
  // the real Submit button) that swallows the click the exact same way. This
  // silently produced 'submit-unconfirmed' on an otherwise fully-filled form -
  // the highest-value class of false failure, since the hard work (autofill)
  // had already succeeded.
  await pg.evaluate(() => {
    document.querySelectorAll('[class*="shadow-root" i], [id*="chatbot" i], [class*="chatbot" i]')
      .forEach(e => { e.style.pointerEvents = 'none'; });
  }).catch(() => {});
  // Usercentrics (German-language sites: Mercedes) labels its button
  // "Akzeptieren" - none of the English texts below match it.
  const SELS = ['#onetrust-accept-btn-handler', '[data-testid="uc-accept-all-button"], button:has-text("Akzeptieren")',
                'button:has-text("Deny"), a:has-text("Deny")',
                'button:has-text("Reject"), a:has-text("Reject")',
                'button:has-text("I consent"), a:has-text("I consent")',
                'button:has-text("I agree"), a:has-text("I agree")',
                'button:has-text("Agree"), a:has-text("Agree")',
                'button:has-text("Accept"), a:has-text("Accept")', '[aria-label*="close" i]'];
  // ONE DOM probe per surface finds which of SELS are present AND rendered;
  // only those get a Playwright click. The old loop did count()+isVisible()
  // for 9 selectors x every frame - 50s of a 125s fill pass on a GE/Phenom
  // page full of tracking iframes (DEBUG_TIME, 2026-09-24).
  const TXT = [null, 'Akzeptieren', 'Deny', 'Reject', 'I consent', 'I agree', 'Agree', 'Accept', null];
  // Search the top document AND every frame - a consent dialog in an
  // iframe is invisible to pg.locator(). Do NOT break: one overlay commonly
  // sits behind another, and clicking a cookie notice can reveal a second.
  const surfaces = [pg, ...((typeof pg.frames === 'function' ? pg.frames() : []).filter(fr => fr !== pg.mainFrame?.() && !/^about:|^$/.test(fr.url ? fr.url() : '')))];
  for (const sf of surfaces) {
    const hits = await Promise.race([
      sf.evaluate(TXT => {
        const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
        const btns = [...document.querySelectorAll('button, a')].filter(vis);
        return TXT.map((t, k) => {
          if (k === 0) return vis(document.querySelector('#onetrust-accept-btn-handler'));
          if (k === 8) return [...document.querySelectorAll('[aria-label*="close" i]')].some(vis);
          if (k === 1 && vis(document.querySelector('[data-testid="uc-accept-all-button"]'))) return true;
          return btns.some(b => (b.innerText || '').toLowerCase().includes(t.toLowerCase()));
        });
      }, TXT).catch(() => null),
      new Promise(r => setTimeout(() => r(null), 1500)),
    ]);
    if (!hits) continue;
    for (let k = 0; k < SELS.length; k++) {
      if (!hits[k]) continue;
      const el = sf.locator(SELS[k]).first();
      if (!await el.isVisible().catch(() => false)) continue;
      await el.click({ timeout: 2500 }).catch(() => {});
      await pg.waitForTimeout(500);
    }
  }
}
// Some ATSs (Paylocity most visibly) ship the work-history and education
// sections COLLAPSED behind an 'Add ...' button. The fields do not exist in
// the DOM until it is clicked, so every filler skipped them and the ATS then
// refused the form for missing required entries - 9 Paylocity jobs sat at
// ~44/77 filled and died as no-submit-btn because step 1 never validated.
// Click each repeater at most once, then let the normal fillers see the new
// fields in this same pass.
const REPEATER = /^add\s+(work\s*history|employment|education|school|degree|experience|position|previous employer)/i;
const REPEAT_ON = process.env.REPEAT === '1';
let REPEATED = false;   // reset per job - fillAll runs once PER WIZARD STEP
async function expandRepeaters(pg) {
  // Default OFF. fillCycle calls fillAll once per wizard step, so an unguarded
  // expander clicked 'Add Work History' on every step and built SIX entries on
  // one Paylocity form (workHistory.startDate.0 .. .5). Each entry adds its own
  // required Country/State/County address block, and 'county' is explicitly
  // unknown in answers.json ('Not known. Gap it.'), so every extra entry made
  // the form LESS submittable - 75/125 with 12 unsatisfiable required fields.
  if (!REPEAT_ON || REPEATED) return 0;
  REPEATED = true;
  let opened = 0;
  const btns = await pg.locator('button:visible, a[role=button]:visible').all().catch(() => []);
  for (const bt of btns.slice(0, 40)) {
    const t = await bt.innerText().catch(() => '');
    if (!REPEATER.test((t || '').replace(/\s+/g, ' ').trim())) continue;
    await bt.click({ timeout: 4000 }).catch(() => {});
    await pg.waitForTimeout(1400);
    if (++opened >= 3) break;   // one entry each for history/education is enough
  }
  return opened;
}
async function fillAll(pg) {
  // DEBUG_TIME=1: per-stage wall time, to find where big forms (Palantir,
  // GE/Phenom) spend a whole JOB_TIMEOUT inside one fill pass.
  const TT = process.env.DEBUG_TIME ? {} : null; let t0 = Date.now();
  const lap = k => { if (TT) { TT[k] = (TT[k] || 0) + Date.now() - t0; t0 = Date.now(); } };
  await dismissBanners(pg); lap('banners');
  await expandRepeaters(pg); lap('repeat');
  await fillText(pg); lap('text1');
  let a = await fillSelects(pg); lap('selects');
  // Dependent selects (Phenom "Source Type" -> "Source") only get options
  // after the parent is chosen; one pass saw a placeholder-only list and
  // gapped it (Univera, MITRE, 2026-09-25). If anything is still open, give
  // the cascade a moment and answer again - filled selects are skipped.
  if (a.length) {
    // Excellus: parent answered "Website", child still placeholder-only on the
    // second pass. Re-fire change on every answered select so a framework that
    // missed the first event loads the child list, then give it time.
    await pg.evaluate(() => document.querySelectorAll('select').forEach(s => { if (s.selectedIndex > 0) { s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); } })).catch(() => {});
    // Poll instead of a fixed wait: the dependent list loaded inside 3s on one
    // Excellus run and not on two later ones (09-25).
    const emptyReq = () => pg.evaluate(() => [...document.querySelectorAll('select')].some(s => (s.required || s.getAttribute('aria-required') === 'true') && s.offsetParent && [...s.options].every(o => /^(please|select|choose|--|\s*$)/i.test(o.text.trim())))).catch(() => false);
    for (let k = 0; k < 10 && await emptyReq(); k++) await pg.waitForTimeout(1000);
    a = await fillSelects(pg); lap('selects2');
  }
  const r = await fillRadios(pg); lap('radios');
  // Groups MUST run before singles: it tags its own options with
  // data-ja-group so fillCheckboxes() skips them instead of asking a
  // nonsensical Yes/No about each option label in isolation.
  const cg = await fillCheckboxGroups(pg); lap('cbgroups');
  const cb = await fillCheckboxes(pg); lap('checkbox');
  const yn = await fillYesNo(pg); lap('yesno');
  const co = await fillComboboxes(pg); lap('combos');
  // Some text fields (city/zip on a cascading address block, seen on
  // Paylocity) only become fillable AFTER a country/state select resolves,
  // or simply hydrate slower than the rest of the form. A single-page form
  // with no wizard "Next" step gives fillText() exactly one pass, so without
  // this second call those fields never get a second chance.
  const tx = await fillText(pg); lap('text2');
  await fillFiles(pg); lap('files');
  await repairRequired(pg); lap('repair');
  if (TT) console.error('[time]', JSON.stringify(TT));
  return [...a, ...r, ...cg, ...cb, ...yn, ...co, ...tx];
}


// Re-type required-and-empty text fields with real keystrokes + blur. Last
// resort for web-component inputs that discard an el.fill() value. Bounded to
// 6 fields so a genuinely unanswerable form does not burn the job timeout.
// Error-driven repair. Ashby (and Paylocity) print the EXACT field that
// blocked the submission - "Your form needs corrections / Missing entry for
// required field: Email" - on forms this script had already counted as fully
// filled with zero unresolved gaps. Nothing ever read those messages back and
// retried, so a form we had the answer for ("Email", "How did you hear about
// us?") died as submit-unconfirmed. Re-type with real keystrokes: a plain
// fill() leaves Ashbys React state unset, which is why the field reads filled
// to us and empty to the ATS.
const ERR_SPLIT_RE = /missing entry for required field\s*:?\s*/i;
function errFieldNames(msgs) {
  const out = [];
  for (const t of msgs) {
    // Ashby concatenates several of these into one banner; splitting on the
    // phrase yields exactly the field names between occurrences.
    if (ERR_SPLIT_RE.test(t)) {
      for (const part of t.split(new RegExp(ERR_SPLIT_RE.source, "ig")).slice(1)) {
        const n = part.replace(/[\u2731*]|\(required\)/gi, "").trim().slice(0, 90);
        if (n.length >= 3 && !out.includes(n)) out.push(n);
      }
      continue;
    }
    // "<Field> is required" - the only other form specific enough to trust.
    const m = t.match(/^\s*[\u2731*]?\s*([A-Za-z][^.\n]{2,60}?)\s+is\s+required\b/i);
    if (m) { const n = m[1].trim(); if (!out.includes(n)) out.push(n); }
  }
  return out;
}
async function repairFromErrors(pg) {
  const msgs = await navErrors(pg);
  if (!msgs.length) return { fixed: 0, named: [] };
  const named = errFieldNames(msgs);
  if (!named.length) return { fixed: 0, named: [] };
  let fixed = 0;
  for (const name of named.slice(0, 6)) {
    // A named DOCUMENT field ("Missing entry for required field: Resume"):
    // the text path below skips file inputs, so re-attach the file directly.
    const doc = /transcript|academic record/i.test(name) ? 'transcript.pdf' : /r[eé]sum[eé]|\bcv\b/i.test(name) ? 'resume.pdf' : null;
    if (doc) {
      for (const f of await pg.locator('input[type=file]').all().catch(() => [])) {
        const lab = await f.evaluate(e => { let t = '', p = e.parentElement, h = 0; while (p && h++ < 4 && !t) { const s = (p.innerText || '').trim(); if (s.length > 3 && s.length < 200) t = s; p = p.parentElement; } return t; }).catch(() => '');
        if (/^autofill from/i.test(lab) || !new RegExp(doc === 'resume.pdf' ? 'r[eé]sum[eé]|\\bcv\\b' : 'transcript|academic', 'i').test(lab)) continue;
        const err = await f.setInputFiles(`${HOME}/.jobagent/${doc}`, { timeout: 12000 }).then(() => null).catch(e => String(e.message).slice(0, 60));
        FILE_LOG.push({ lab: `repair:${lab.slice(0, 30)}`, err });
        if (!err) { fixed++; await pg.waitForTimeout(2500); }
        break;
      }
      continue;
    }
    // Resolve the value the same three ways the fill path does, INCLUDING
    // learned.json, which repairRequired never consulted.
    const learned = Object.entries(LEARNED).find(([k]) => name.toLowerCase().includes(k.toLowerCase()));
    const want = bankValue(name) || (learned ? learned[1] : null) || llmGet((name)) || infer(name, []);
    if (!want) continue;
    // Find the control whose own label matches the name the ATS printed.
    const els = await pg.locator("input:visible, textarea:visible, select:visible").all().catch(() => []);
    for (const el of els) {
      const info = await el.evaluate((e, lbl) => { eval(lbl);
        const ty = (e.type || e.tagName).toLowerCase();
        return { ty, l: LBL(e), v: String(e.value || "") };
      }, LBL_SRC).catch(() => null);
      if (!info || ["hidden", "submit", "button", "file"].includes(info.ty)) continue;
      const li = String(info.l || "").toLowerCase(), ni = name.toLowerCase();
      if (!li || !(li.includes(ni) || ni.includes(li))) continue;
      if (info.ty === "select") {
        const opts = await el.evaluate(e => [...e.options].map(o => (o.label || o.text || "").trim())
          .filter(t => t && !/^(select|choose|please select|--)/i.test(t))).catch(() => []);
        const choice = opts.length ? (fuzzyOpt(opts, want) || infer(name, opts)) : null;
        if (choice) {
          const ok = await el.selectOption({ label: choice }).then(() => true).catch(() => false);
          if (ok) fixed++;
        }
      } else if (info.ty === "checkbox" || info.ty === "radio") {
        continue;   // see comment above errFieldNames: never assert an arbitrary option
      } else {
        await el.click({ timeout: 1500 }).catch(() => {});
        await el.fill("", { timeout: 1500 }).catch(() => {});
        await el.pressSequentially(String(want).slice(0, 90), { timeout: 5000, delay: 15 }).catch(() => {});
        // Commit a typeahead by picking its first suggestion. Typing alone
        // leaves Ashby's value unset, so the ATS keeps reporting the field
        // missing no matter how many times we retype it.
        const typeahead = /location|city|address|school|universit|company|country|state|province/i.test(name);
        let picked = false;
        if (typeahead) {
          await pg.waitForTimeout(1200);
          picked = await pg.locator('[role=option]:visible, [class*="select__option"]:visible').first()
            .click({ timeout: 2500 }).then(() => true).catch(() => false);
        }
        if (!picked) await el.press("Tab").catch(() => {});
        await pg.waitForTimeout(250);
        const got = picked ? "1" : await el.inputValue({ timeout: 1500 }).catch(() => null);
        if (got && String(got).trim()) fixed++;
      }
      break;
    }
  }
  if (process.env.DEBUG_REPAIR) console.error("[err-repair]", JSON.stringify({ named, fixed }));
  // Yes/No button groups are skipped above. Ashby dropped an already-pressed
  // answer ("could you confirm you are currently authorized to work") and
  // refused the form (Snowflake, 2026-09-25). fillYesNo() only touches groups
  // with nothing pressed and answers them by the same infer() policy.
  const pressedCount = () => pg.evaluate(() => document.querySelectorAll('[data-field-entry-id] button[aria-pressed="true"]').length).catch(() => 0);
  const p0 = await pressedCount();
  await fillYesNo(pg).catch(() => []);
  fixed += Math.max(0, (await pressedCount()) - p0);
  return { fixed, named };
}

async function repairRequired(pg) {
  let fixed = 0;
  for (const el of await pg.locator('input:visible, textarea:visible').all().catch(() => [])) {
    if (fixed >= 6) break;
    const m = await el.evaluate((e, lbl) => { eval(lbl);
      const ty = (e.type || e.tagName).toLowerCase();
      return { ty, l: LBL(e), v: String(e.value || ''),
               req: !!(e.required || e.getAttribute('aria-required') === 'true') };
    }, LBL_SRC).catch(() => null);
    if (!m || ['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(m.ty)) continue;
    if (!m.req || String(m.v).trim()) continue;
    const v = bankValue(m.l) || llmGet((m.l));
    if (!v) continue;
    await el.click({ timeout: 1500 }).catch(() => {});
    await el.pressSequentially(String(v).slice(0, 80), { timeout: 5000, delay: 15 }).catch(() => {});
    await el.press('Tab').catch(() => {});
    await pg.waitForTimeout(250);
    const got = await el.inputValue({ timeout: 1500 }).catch(() => null);
    if (process.env.DEBUG_TXT) console.error('[repair]', JSON.stringify({ l: String(m.l).slice(0, 45), want: String(v).slice(0, 26), got: got === null ? null : String(got).slice(0, 26) }));
    if (got && String(got).trim()) fixed++;
  }
  return fixed;
}

// One full fill sweep, walking a multi-step wizard if present (SPA forms do
// not change URL, so step advance is detected via the "Step N of M" label).
// Factored out of the main loop so it can be run AGAIN after the LLM resolves
// the gaps the first sweep reported.
// Validation messages the ATS itself printed when a wizard refused to advance.
// Per job; read back onto the ledger record so a stalled wizard says WHY.
let NAV_ERRS = [];
// Signatures of every wizard step actually visited, so a stalled or
// truncated walk can be read off the ledger instead of re-run blind.
let WIZ_TRAIL = [];
const wizSig = pg => pg.evaluate(() => {
  const vis = e => e.getClientRects().length > 0;
  const n = [...document.querySelectorAll('input,select,textarea')].filter(vis).length;
  const h = (document.querySelector('h1,h2,legend')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return location.href + '|' + n + '|' + h;
}).catch(() => null);
// Paylocity re-renders its wizard slowly (its resume parse alone needs ~14s).
// A single fixed wait sampled the signature BEFORE the new step painted, so an
// advance that actually happened looked like a refusal and the walk gave up.
const waitSigChange = async (pg, before, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await pg.waitForTimeout(1500);
    const now = await wizSig(pg);
    if (now && now !== before) return now;
  }
  return await wizSig(pg);
};
const navErrors = pg => pg.evaluate(() =>
  [...document.querySelectorAll('[class*=error],[role=alert],[aria-invalid="true"]')]
    .filter(e => e.getClientRects().length > 0)
    .map(e => (e.innerText || '').replace(/\s+/g, ' ').trim())
    .filter(t => t && t !== '--').slice(0, 10)).catch(() => []);

// Paylocity parses the uploaded resume into work-history rows and sometimes
// leaves one incomplete - its own parser found no start date. That row's
// "Start Date (required)" input carries required=false, so scan() never
// flagged it, yet the wizard refuses to advance on it. Drop the row the ATS
// failed to populate instead of inventing employment dates for it.
async function pruneIncompleteRows(pg) {
  let removed = 0;
  for (let i = 0; i < 6; i++) {
    const idx = await pg.evaluate(() => {
      const vis = e => e.getClientRects().length > 0;
      const bad = [...document.querySelectorAll('input[id^="txt-workHistory-startDate-"]')]
        .find(e => vis(e) && !String(e.value || '').trim());
      if (!bad) return null;
      const m = bad.id.match(/-(\d+)$/);
      return m ? Number(m[1]) : null;
    }).catch(() => null);
    if (idx === null) break;
    const btns = await pg.locator('button:has-text("Delete This Work History")').all().catch(() => []);
    if (!btns[idx]) break;
    await btns[idx].click({ timeout: 4000 }).catch(() => {});
    await pg.waitForTimeout(1200);
    removed++;
  }
  return removed;
}

// JobRight extension "Autofill" button. It used to be clicked exactly once, by
// an instant count() on the LANDING page: the extension injects the button a
// few seconds after load, and the reveal step often moves to a new tab/page
// (Apply click, iframe, direct ATS href) where it was never clicked at all -
// the user watched it sit unclicked with every field empty (2026-09-25).
// Poll for it, click it once per distinct page, wait for fills to settle.
const EXT_AF_DONE = new Set();
async function extAutofill(pg) {
  const key = (() => { try { return pg.url().split('#')[0]; } catch { return ''; } })();
  if (!key || EXT_AF_DONE.has(key)) return 0;
  const af = pg.locator('button', { hasText: /^\s*Autofill\s*$/ });
  let n = 0;
  for (let k = 0; k < 10 && !(n = await af.count().catch(() => 0)); k++) await pg.waitForTimeout(800);
  if (!n) { AF_LOG.push({ page: key.slice(0, 60), found: 0 }); return 0; }
  EXT_AF_DONE.add(key);
  const before = (await scan(pg).catch(() => null))?.filled ?? null;
  const vis = af.filter({ visible: true });
  const target = await vis.count().catch(() => 0) ? vis.first() : af.first();
  const err = await target.click({ timeout: 8000 }).then(() => null).catch(e => String(e.message).slice(0, 60));
  // Live probe: 0 fields at +4s, 3 at +8s, 9 by +16s. Stopping at the first
  // unchanged reading quit before it started. Wait for growth (up to 14s),
  // then until two readings in a row show no more.
  const t0 = Date.now(); let now = before ?? 0, last = now, grew = false, stable = 0;
  while (Date.now() - t0 < 30000) {
    await pg.waitForTimeout(2500);
    now = (await scan(pg).catch(() => null))?.filled ?? now;
    if (now > last) { grew = true; stable = 0; last = now; }
    else if (grew ? ++stable >= 2 : Date.now() - t0 > 22000) break;
  }
  AF_LOG.push({ page: key.slice(0, 60), found: n, err, before, after: now });
  return 1;
}
let AF_LOG = [];

async function fillCycle(tab) {
  let unresolved = [];
  await extAutofill(tab);
  for (let step = 0; step < 8; step++) {
    if (step > 0) extendDeadline();   // reached a new step = real progress
    phase('fill'); unresolved = await fillAll(tab);
    // Later wizard steps never got an LLM pass - the only askLLM call runs
    // after step 0, so Activision's step-2 "Are you currently enrolled?" /
    // "Graduation Year" gapped with the answer derivable (2026-09-24).
    if (step > 0 && unresolved.length && LLM_ON && FACTS) {
      const fresh = unresolved.filter(u => u.q && !llmGet(u.q));
      if (fresh.length) {
        const ans = await askLLM(fresh, FACTS, { jobTitle: String(CUR_JOB?.txt || '').slice(0, 80), ats: tab.url() }).catch(() => new Map());
        let got = 0; for (const [k, v] of ans) if (v) { LLM_ANS.set(k, v); got++; }
        if (got) { extendDeadline(); unresolved = await fillAll(tab); }
      }
    }
    const st = await scan(tab);
    if (!st) { WIZ_TRAIL.push('scan-null'); break; }
    WIZ_TRAIL.push(step + ':' + (st.filled + '/' + st.total) + ':' + String((await wizSig(tab)) || '').slice(-40));
    if (st.captcha && !allowed(tab.url())) return { captcha: true, capWhy: st.capWhy, unresolved };
    const next = tab.locator('button:has-text("Next"), button:has-text("Continue"), button:has-text("Save and Continue")').first();
    if (!await next.count().catch(() => 0)) { WIZ_TRAIL.push('no-next'); break; }
    if (!await next.isEnabled().catch(() => false)) { WIZ_TRAIL.push('next-disabled'); break; }
    const labelBefore = st.step;
    const sigBefore = await wizSig(tab);
    await next.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    const clicked = await next.click({ timeout: 6000 }).then(() => true).catch(() => false);
    if (!clicked) await next.evaluate(e => e.click()).catch(() => {});
    await waitSigChange(tab, sigBefore);
    const after = await scan(tab);
    if (!after) break;
    // A wizard that REFUSES to advance was previously re-filled up to 8 times.
    // On an 80-field Paylocity form that alone blew the job timeout and killed
    // the CDP connection, and the ledger just said 'no-submit-btn'. The old
    // guard only compared st.step ('Step N of M'), which Paylocity never
    // renders, so it never fired. Compare a real page signature instead and
    // keep the ATS's own validation text.
    let sigAfter = await wizSig(tab);
    if (sigBefore && sigAfter && sigBefore === sigAfter) {
      NAV_ERRS = await navErrors(tab);
      if (process.env.DEBUG_NAV) console.error('[nav-vals]', JSON.stringify(await tab.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]), select')].filter(e => e.getClientRects().length).map(e => { const l = (e.labels && e.labels[0] ? e.labels[0].innerText : e.getAttribute('aria-label') || e.name || e.id || '').replace(/\s+/g, ' ').trim().slice(0, 40); return l + '=' + (e.tagName === 'SELECT' ? (e.selectedOptions[0]?.text || '') + ' {' + [...e.options].slice(0, 6).map(o => o.text).join('/') + '}' : e.value).slice(0, 90); })).catch(() => 'err')));
      // The ATS's refusal is INFORMATION, not a dead end. Two of its causes
      // only become visible at this moment: a conditional control that renders
      // once an earlier field is set (Paylocity's SMS-consent question appears
      // only after a mobile number is entered) and a resume-parsed row the ATS
      // left half-empty. Recover once - prune, refill, retry - before giving up.
      const pruned = await pruneIncompleteRows(tab).catch(() => 0);
      await fillAll(tab);
      await tab.waitForTimeout(1200);
      await next.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
      const again = await next.click({ timeout: 6000 }).then(() => true).catch(() => false);
      if (!again) await next.evaluate(e => e.click()).catch(() => {});
      await tab.waitForTimeout(3600);
      sigAfter = await wizSig(tab);
      if (sigBefore && sigAfter && sigBefore === sigAfter) {
        NAV_ERRS = await navErrors(tab);
        if (pruned) NAV_ERRS.push('(pruned ' + pruned + ' incomplete row(s))');
        break;
      }
      NAV_ERRS = [];   // recovered - do not report a stall that no longer exists
    }
    if (after.step && after.step === labelBefore) break;
  }
  return { captcha: false, unresolved };
}
const LLM_ON = process.env.LLM !== '0';
// 150s was set before the agentic pass existed. One LLM round-trip is 15-25s
// and a resolved form gets a SECOND full fill cycle, so a job that now fills
// completely can run past the old budget and be lost to err:timeout with the
// work already done (observed: Dover at 9/9 filled).
// A timeout throws away ALL the work already done on that job (observed:
// careerpuck resolved 15 of 18 gaps and then died at the deadline with
// nothing submitted). Being generous here is much cheaper than losing a
// nearly-complete application.
const JOB_TIMEOUT = Number(process.env.JOB_TIMEOUT || 360000);
let PHASE = 'init';
let JOB_T0 = Date.now();
const phase = p => { PHASE = p; if (process.env.DEBUG_TIME) console.error(`[phase] ${p} +${Math.round((Date.now() - JOB_T0) / 1000)}s`); };

let b = await chromium.connectOverCDP('http://localhost:9222');
let c = b.contexts()[0];
// Playwright's 30s DEFAULT timeout was the biggest single time sink on big
// forms: locator.evaluate() on a stale nth-locator (the form re-rendered after
// a fill) waits the full 30s for an element that no longer exists. 7 such
// fields = 210s of Palantir's 207s text pass (DEBUG_TIME [slowfield],
// 2026-09-24). Every intentional wait here passes an explicit timeout.
const DEFAULT_TO = Number(process.env.DEFAULT_TIMEOUT || 6000);
c.setDefaultTimeout(DEFAULT_TO);
// An ATS page firing a native dialog (alert/confirm/beforeunload) with no
// listener registered lets playwright-core auto-handle it internally - and
// that internal path has thrown from inside its own event listener
// (DialogManager.dialogDidOpen), which Node treats as an uncaughtException
// and kills the whole process on a tick our try/catch never sees. Registering
// our own listener on every page in the context intercepts the dialog first.
const armDialogHandler = ctx => ctx.on('page', pg => pg.on('dialog', d => d.dismiss().catch(() => {})));
armDialogHandler(c);
// Extendable deadline. A multi-step wizard that is genuinely ADVANCING
// (Phenom: GE/CAI/Cisco/Battelle, unblocked 2026-09-24 by the Country-first
// fix) needs more than JOB_TIMEOUT; one that is stuck does not. Each real
// step advance buys 2 min, capped at JOB_MAX from the job's start.
let JOB_DEADLINE = 0;
const JOB_MAX = Number(process.env.JOB_MAX || 600000);
const extendDeadline = () => { if (JOB_DEADLINE) JOB_DEADLINE = Math.min(JOB_T0 + JOB_MAX, Math.max(JOB_DEADLINE, Date.now() + 120000)); };
const withTimeout = (pr, ms) => { JOB_DEADLINE = Date.now() + ms;
  return Promise.race([pr, new Promise((_, rj) => { const tick = () => Date.now() > JOB_DEADLINE ? rj(new Error('timeout')) : setTimeout(tick, 1000); setTimeout(tick, 1000); })]); };
// Some jobs kill the whole CDP connection outright (observed: a page/context
// dies mid-job and every subsequent c.newPage() fails with "Target page,
// context or browser has been closed" for the REST of the run - one bad job
// silently zeroed the tail of two separate multi-hour batches). Reconnecting
// instead of cascading turns a total-batch loss into a single-job loss.
const DEAD_BROWSER = /target page, context or browser has been closed|browser has been closed|connection closed|websocket.{0,20}closed/i;
async function reconnect() {
  try { await b.close(); } catch {}
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      b = await chromium.connectOverCDP('http://localhost:9222');
      c = b.contexts()[0]; c.setDefaultTimeout(DEFAULT_TO);
      armDialogHandler(c);
      await c.newPage().then(p => p.close());   // prove the fresh connection actually works
      return true;
    } catch { await new Promise(r => setTimeout(r, 3000)); }
  }
  return false;
}
let n = 0, sub = 0, deadStreak = 0;
console.log(`offsite queue: ${queue.length}`);

for (const j of queue) {
  n++;
  if (ONLY.length ? !ONLY.includes(j.id) : done.has(j.id)) continue;
  // ts/run: see apply3.mjs - lets a rate be scoped to one run.
  const rec = { id: j.id, title: (j.title || '').slice(0, 55), ts: new Date().toISOString(), run: RUN_ID };
  if (skipListed(j.title)) {
    rec.status = 'skip-listed';
    fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
    console.log(`[${n}/${queue.length}] ${'skip-listed'.padEnd(21)} -/- ${rec.title.slice(0, 40)}`);
    continue;
  }
  LLM_ANS.clear();          // answers are per-form; never leak across jobs
  CUR_JOB = j;
  ANS_LOG = [];
  FILE_LOG = []; AF_LOG = []; EXT_AF_DONE.clear();
  // Reap tabs left by THIS worker's earlier jobs. A timed-out job's async
  // body keeps running after withTimeout rejects, so it can open tabs after
  // cleanup ran; 26 leaked tabs accumulated in 20 minutes and wedged CDP
  // (connectOverCDP 30s timeouts, 2026-09-24). Ownership by job id (jr_id= or
  // /jobs/info/<id>) never touches another worker's tabs.
  if (MY_IDS.length) {
    for (const pg of c.pages()) {
      const u = pg.url();
      if (MY_IDS.some(id => u.includes(`jr_id=${id}`) || u.includes(`/jobs/info/${id}`))) await pg.close().catch(() => {});
    }
  }
  // jr_id alone missed tabs that REDIRECTED off it (Taleo, iCIMS login, SAP):
  // 8 of 18 open tabs were such leaks at load avg 25 (2026-09-24). A timed-out
  // job's body can still add to its OWN set after cleanup, so keep the sets.
  for (const set of PAST_OWN) for (const pg of set) if (!pg.isClosed()) await pg.close().catch(() => {});
  if (PAST_OWN.length) for (const pg of c.pages()) {
    if (pg.isClosed()) continue;
    const op = await pg.opener().catch(() => null);
    if (op && PAST_OWN.some(set => set.has(op))) await pg.close().catch(() => {});
  }
  MY_IDS.push(j.id); if (MY_IDS.length > 40) MY_IDS.shift();
  let p = null, tab = null, jobCrashed = false;
  // Tab OWNERSHIP. Several offsite3 workers share one Chrome context, and
  // c.pages()/c.waitForEvent('page') see EVERY worker's tabs. Unscoped, a
  // worker adopted another worker's ATS tab (Hearst's record carried Grant
  // Thornton's URL) and its cleanup closed the others' live forms ("Target
  // page closed", scan-failed, ERR_ABORTED - 2026-09-24). A new page is ours
  // only if its opener is ours or its URL carries THIS job's jr_id.
  const OWN = new Set();
  PAST_OWN.push(OWN); if (PAST_OWN.length > 12) PAST_OWN.shift();
  const findOwn = async before => {
    for (const pg of c.pages()) {
      if (before.has(pg) || pg.isClosed()) continue;
      if (OWN.has(pg) || pg.url().includes(`jr_id=${j.id}`)) return pg;
      const op = await pg.opener().catch(() => null);
      if (op && OWN.has(op)) return pg;
    }
    return null;
  };
  REPEATED = false;   // per-job: each job gets one repeater expansion, not one per run
  NAV_ERRS = []; WIZ_TRAIL = [];
  try {
    JOB_T0 = Date.now(); phase('open');
    await withTimeout((async () => {
      p = await c.newPage(); OWN.add(p);
      await p.goto(`https://jobright.ai/jobs/info/${j.id}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await p.waitForTimeout(3200);
      await p.evaluate(() => { const t = document.getElementById('___reactour'); if (t) t.remove(); });
      let btn = p.locator('button:has-text("APPLY WITH AUTOFILL")').first();
      // No autofill button: go straight to the job's own applyLink from
      // __NEXT_DATA__ instead of clicking APPLY NOW. The click path ended
      // 'no-ats-tab' on 35 of 48 attempts, and a 2026-09-23 probe showed the
      // link is usually the company's own ATS (SuccessFactors, Phenom, Ashby),
      // not the LinkedIn/ZipRecruiter relay apply3 assumed.
      const applyLink = await p.evaluate(() => {
        const m = (document.getElementById('__NEXT_DATA__')?.textContent || '').match(/"applyLink":"(https?:[^"]+)"/);
        return m ? JSON.parse(`"${m[1]}"`) : null;
      }).catch(() => null);
      // Policy skips decided from the link itself, before the autofill click
      // and its up-to-34s tab wait. Workday alone was 81 of 264 outcomes at
      // ~20s each (2026-09-24).
      if (applyLink && /myworkdayjobs\.com|workdayjobs|\/wday\//i.test(applyLink)) { rec.ats = applyLink.slice(0, 300); rec.status = 'skip-workday'; rec.fast = 1; return; }
      if (applyLink && /\.taleo\.net\/careersection\/|myjobs\.adp\.com\//i.test(applyLink)) { rec.ats = applyLink.slice(0, 300); rec.status = 'skip-account'; rec.fast = 1; return; }
      if (applyLink && skipListed(applyLink) && !await btn.count().catch(() => 0)) { rec.ats = applyLink.slice(0, 300); rec.status = 'skip-listed'; rec.fast = 1; return; }
      const directLink = await btn.count().catch(() => 0) ? null : applyLink;
      if (directLink) {
        rec.via = 'applylink';
        tab = await c.newPage(); OWN.add(tab);
        await tab.goto(directLink, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      } else if (!await btn.count().catch(() => 0)) {
        // No extension autofill offered. That is not a reason to give up: the
        // plain apply link reaches the same ATS form, and our own bank fill
        // does the work the extension would have. 60 jobs in one ledger died
        // here for no reason.
        const alt = p.locator('button:has-text("APPLY NOW"), a:has-text("APPLY NOW"), button:has-text("Apply Now"), a:has-text("Apply Now"), button:has-text("APPLY"), a:has-text("APPLY")').first();
        if (!await alt.count().catch(() => 0)) { rec.status = 'no-apply-btn'; return; }
        btn = alt; rec.via = 'apply-now';
      }
      const pagesBefore = new Set(c.pages());
      if (!tab) {
      let popped = null; const onPop = pg => { popped = pg; };
      p.on('popup', onPop);
      await btn.click({ timeout: 10000 }).catch(() => {});     // MUST be trusted
      for (let k = 0; k < 22 && !tab; k++) { await p.waitForTimeout(1000); tab = popped || await findOwn(pagesBefore); }
      p.off('popup', onPop);
      // 'no-ats-tab' was 4 of 40 jobs in one batch and is not one failure but
      // three: the popup can arrive after the 22s event window, it can appear
      // without firing an event we caught, or the link can navigate the SAME
      // tab instead of opening a new one. Check all three before giving up.
      if (!tab) {
        for (let k = 0; k < 4 && !tab; k++) {
          await p.waitForTimeout(3000);
          tab = await findOwn(pagesBefore);
        }
      }
      if (!tab && !/jobright\.ai/.test(p.url())) {
        // Same-tab navigation: the jobright page itself became the ATS page.
        // Keep it as the working surface and drop the p/tab distinction - the
        // cleanup at the bottom closes non-jobright pages anyway.
        rec.sameTab = 1; tab = p;
      }
      }
      if (!tab) { rec.status = 'no-ats-tab'; return; }
      OWN.add(tab);
      await tab.waitForLoadState('domcontentloaded').catch(() => {});
      await tab.waitForTimeout(2500);
      // Rippling picks a page locale per visit regardless of Accept-Language
      // (de-DE one visit, en-AU the next); a German page has no "Apply" text.
      if (/ats\.rippling\.com\/(?!en-)[a-z]{2}-[A-Z]{2}\//.test(tab.url())) {
        // The locale is a NEXT_LOCALE cookie (found set to de-DE); the URL
        // rewrite alone gets redirected straight back without resetting it.
        await c.addCookies([{ name: 'NEXT_LOCALE', value: 'en-US', domain: 'ats.rippling.com', path: '/' }]).catch(() => {});
        await tab.goto(tab.url().replace(/(ats\.rippling\.com\/)[a-z]{2}-[A-Z]{2}\//, '$1en-US/'), { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await tab.waitForTimeout(2500);
      }
      rec.ats = tab.url().slice(0, 300);

      // Workday always requires an account before the form renders, so it shows
      // up as an empty page. Label it honestly instead of hiding it in
      // 'no-form-found' - user rule is to skip Workday outright.
      if (/myworkdayjobs\.com|workdayjobs|workday\.com|\/wday\//i.test(tab.url())) { rec.status = 'skip-workday'; return; }
      if (skipListed(tab.url())) { rec.status = 'skip-listed'; return; }
      // Closed postings, detected BEFORE any fill: jobs.workable.com/view says
      // "This job is not available anymore" above a signup form, and 7 of 9
      // such jobs were filled and logged needs-inference (2026-09-24). Strict
      // phrases only, top of the page only.
      {
        const top = await tab.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1500)).catch(() => '');
        if (/this job is not available anymore|job (posting )?is no longer available|no longer accepting applications|this (job|position|posting) (has )?(expired|been filled|closed)|couldn.t find anything here|the job you requested was not found/i.test(top)) { rec.status = 'skip-closed'; rec.closedWhy = 'early'; return; }
      }
      // Paylocity has never produced a submission: it fills ~45/80 then its
      // "Next Step" neither advances nor errors (gotchas). Meanwhile it was 8
      // of 11 err:timeouts on 2026-09-24, a full JOB_TIMEOUT each. Park it
      // under its own status so it can be re-queued once the wizard is solved.
      if (/recruiting\.paylocity\.com/i.test(tab.url()) && process.env.PAYLOCITY !== '1') { rec.status = 'skip-paylocity-unsolved'; return; }
      // Taleo Enterprise: "Apply Online" leads to candidate sign-in / create
      // account; no guest path. Was 9 too-sparse-refused (1/1) per night.
      if (/\.taleo\.net\/careersection\//i.test(tab.url())) { rec.status = 'skip-account'; rec.why = 'taleo'; return; }
      // ADP MyJobs (not workforcenow): the job page renders only "Sign in"
      // (ADP account). Was 10 too-sparse-refused 0/1 per night (2026-09-24).
      if (/myjobs\.adp\.com\//i.test(tab.url())) { rec.status = 'skip-account'; rec.why = 'adp-myjobs'; return; }
      if (needsAccount(tab.url())) { rec.status = 'skip-account'; return; }

      let s = await scan(tab);
      if (s?.pw) { rec.status = 'skip-login'; return; }             // user rule
      // captcha is judged AFTER Autofill + the Apply-button/iframe reveal below,
      // against whatever page we actually land on - not this initial landing page.

      // extension Autofill lives in an open shadow root; trusted click required
      await extAutofill(tab);
      // reveal a form hidden behind an Apply button (may open yet another tab)
      s = await scan(tab);
      // Eightfold/careers-portal pages land on a job SEARCH view whose facet
      // checkboxes and filter boxes number in the hundreds, so a raw input count
      // says "form found" when there is no application form at all. Trigger the
      // reveal on how little is FILLED, not on how many inputs exist.
      if (s && (s.total < 5 || s.filled < 3)) {
        await dismissBanners(tab);
        // iCIMS (by far the biggest 'no-form-found' host), Greenhouse embeds and
        // careerpuck put the REAL form in an iframe that is ALREADY on the page.
        // The old code only looked for frames after clicking an Apply button -
        // but on these sites that click navigates AWAY from the embedded form,
        // so the form was never seen at all. Check frames first.
        const pre = (typeof tab.frames === 'function' ? tab.frames() : []).filter(fr => fr !== tab.mainFrame?.());
        for (const fr of pre) {
          const f0 = await scan(fr).catch(() => null);
          if (f0 && f0.total >= 5) { rec.frame = fr.url().slice(0, 100); tab = fr; s = f0; break; }
        }
      }
      if (s && (s.total < 5 || s.filled < 3)) {
        // A sparse-landing-page baseline can already be >=5 (e.g. a stray search
        // box), so "s.total >= 5" alone after a click is not proof anything was
        // revealed - a hidden/unstable element matching an earlier selector can
        // time out on click and this would still read as "success" against the
        // unchanged baseline, causing every LATER (correct) selector to never be
        // tried. Require genuine growth past the pre-reveal baseline, captured
        // once, not the click's own possibly-untouched total.
        // A company career page (Phenom: careers.snowflake.com) can carry its
        // own 5-field "talent community" form AND an APPLY NOW <a> whose href is
        // the real ATS on another host. The click path below judged the landing
        // form and refused it 1/5 (2026-09-25). When such a link exists, just go
        // there - the href says exactly where the application lives.
        const atsHref = await tab.evaluate(() => {
          const ATS = /(ashbyhq\.com|lever\.co|greenhouse\.io|smartrecruiters\.com|myworkdayjobs\.com|icims\.com|jobvite\.com|workable\.com|rippling\.com|bamboohr\.com|breezy\.hr|recruitee\.com|teamtailor\.com|paylocity\.com|dayforcehcm\.com)/i;
          const a = [...document.querySelectorAll('a[href]')].find(e => /^https?:/i.test(e.href) && /apply/i.test(e.innerText || '') && ATS.test(e.href) && new URL(e.href).host !== location.host);
          return a ? a.href : null;
        }).catch(() => null);
        if (atsHref) {
          rec.atsHref = atsHref.slice(0, 120);
          if (/myworkdayjobs\.com|workday\.com/i.test(atsHref)) { rec.status = 'skip-workday'; return; }
          // Ashby job pages hold the form at /application; land on it directly.
          const dest = atsHref.replace(/^(https:\/\/jobs\.ashbyhq\.com\/[^/?#]+\/[0-9a-f-]{36})(?!\/application)/i, "$1/application");
          await tab.goto(dest, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          await tab.waitForTimeout(4000);
          // Ashby/Lever job pages put the form behind an "Apply" tab; the
          // selector loop below handles that from the new baseline.
          s = await scan(tab) || s;
        }
        const baseTotal = s?.total || 0;
        const revealed = st => st && st.total >= 5 && st.total > baseTotal;
        // Order matters: the most specific, least ambiguous labels first. A bare
        // "Apply" can match a decorative/nav element on a career portal, which
        // burns the reveal attempt (see gotchas: growth-not-threshold).
        for (const sel of ['button:has-text("Apply Now")', 'a:has-text("Apply Now")',
                           // UKG/UltiPro apply control, confirmed by live probe:
                           // <ukg-button class="ukg-color ...">Apply now</ukg-button>
                           // Custom element, role=null, light-DOM text -- so button/a/
                           // [role=button] has-text selectors ALL miss it. Tag-scoped,
                           // so it cannot hijack another ATS.
                           'ukg-button:has-text("Apply")',
                           'a:has-text("Click here to apply")', 'button:has-text("Click here to apply")',
                           'a:has-text("Apply for this job online")', 'button:has-text("Apply for this job")', 'a:has-text("Apply for this job")',
                           'button:has-text("Apply for this position")', 'a:has-text("Apply for this position")',
                           'button:has-text("Start Application")', 'a:has-text("Start Application")',
                           // hrmdirect (redlattice.hrmdirect.com and friends)
                           'a:has-text("START YOUR APPLICATION")', 'button:has-text("START YOUR APPLICATION")',
                           'button:has-text("Submit Your Application")', 'a:has-text("Submit Your Application")',
                           'button:has-text("Apply to this job")', 'a:has-text("Apply to this job")',
                           'button:has-text("Apply")', 'a:has-text("Apply")',
                           // Localized pages (Rippling served de-DE at random, 2026-09-24):
                           // German / French / Spanish / Portuguese "apply".
                           'button:has-text("Bewerben")', 'a:has-text("Bewerben")',
                           'button:has-text("Postuler")', 'a:has-text("Postuler")',
                           'button:has-text("Aplicar")', 'a:has-text("Aplicar")',
                           'button:has-text("Candidatar")', 'a:has-text("Candidatar")',
                           // SmartRecruiters' apply CTA is literally "I'm interested"
                           // (an <a> to /oneclick-ui/...), matched on the substring to
                           // survive the curly apostrophe. MUST STAY LAST: :has-text is
                           // an unanchored substring, so "Not interested" / "Interested
                           // in other openings?" on any other ATS would otherwise be
                           // clicked ahead of the real Apply button and burn the attempt.
                           'a:has-text("interested")', 'button:has-text("interested")',
                           // :has-text() reads text content, so an
                           // <input type=button value="Apply Now"> matches NOTHING above.
                           // Last, because value*= is an unanchored substring.
                           'input[type=button][value*="Apply" i]', 'input[type=submit][value*="Apply" i]',
                           '[role=button]:has-text("Apply")',
                           // Tag-agnostic, long-phrase-only. iCIMS's control is a
                           // <span>, so every button/a selector above misses it.
                           'text="Apply for this job online"',
                           'text="Apply for this job"',
                           'text="Apply for this position"',
                           'text="Start Application"']) {
          // iCIMS - the single biggest 'no-form-found' host - serves the whole
          // posting, including its "Apply for this job online" link, inside
          // #icims_content_iframe. A locator built on the TOP page cannot see
          // anything in there, so the reveal loop found no Apply control at
          // all and the job was written off as having no form. Taleo, ADP,
          // UltiPro and BambooHR embeds do the same thing. Search the top
          // document AND every child frame for the control.
          const surfaces = [tab, ...((typeof tab.frames === 'function' ? tab.frames() : []).filter(fr => fr !== tab.mainFrame?.()))];
          // A selector can match a hidden or inert duplicate BEFORE the real
          // control - ADP renders two "Apply" elements and hrmdirect two
          // identical "START YOUR APPLICATION" anchors. Preferring a VISIBLE
          // match was not enough: both duplicates are visible, the first one
          // does nothing when clicked, and .first() then burned the entire
          // selector attempt on it (same class of bug as Lever's 0x0 hidden
          // submit, see gotchas). Collect the candidates and actually TRY them.
          let cands = [];
          for (const sf of surfaces) {
            const vis = sf.locator(sel).filter({ visible: true });
            const n = Math.min(await vis.count().catch(() => 0), 3);
            for (let i = 0; i < n; i++) cands.push({ el: vis.nth(i), sf });
            if (n) break;
            const raw = sf.locator(sel).first();
            if (await raw.count().catch(() => 0)) { cands.push({ el: raw, sf }); break; }
          }
          if (!cands.length) continue;
          const before = new Set(c.pages());
          let el = cands[0].el, elSurface = cands[0].sf;
          // Stop at the first candidate that actually changes something: a new
          // tab, a navigation, or inputs appearing. A dud click costs ~1.2s now
          // instead of the whole selector.
          for (const cnd of cands) {
            const u0 = tab.url();
            const n0 = await tab.locator('input,select,textarea').count().catch(() => 0);
            await cnd.el.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
            const clicked = await cnd.el.click({ timeout: 6000 }).then(() => true).catch(() => false);
            await tab.waitForTimeout(clicked ? 5000 : 1200);
            el = cnd.el; elSurface = cnd.sf;
            if (await findOwn(before)) break;
            const n1 = await tab.locator('input,select,textarea').count().catch(() => 0);
            if (tab.url() !== u0 || n1 > n0 + 2) break;
          }
          const np = await findOwn(before);
          if (np) {
            OWN.add(np);
            await np.waitForLoadState('domcontentloaded').catch(() => {});
            await np.waitForTimeout(2500);
            // The reveal click itself can land straight on Workday (e.g. NVIDIA's
            // "Apply Now" opens a wd5.myworkdayjobs.com tab whose intro screen has
            // 0 real inputs yet) - revealed() would never fire, so this fell through
            // to too-sparse-refused instead of the policy's honest skip-workday.
            if (/myworkdayjobs\.com|workdayjobs|workday\.com|\/wday\//i.test(np.url())) { tab = np; rec.status = 'skip-workday'; return; }
            const ns = await scan(np); if (revealed(ns)) { tab = np; s = ns; break; }
          }
          // The click may have revealed the form in the SAME surface it lived
          // in (an iCIMS iframe swaps its own content in place), which the
          // top-document scan below cannot see.
          if (elSurface !== tab) {
            const es = await scan(elSurface).catch(() => null);
            if (es && es.total >= 5) { rec.frame = (elSurface.url ? elSurface.url() : '').slice(0, 100); tab = elSurface; s = es; break; }
          }
          s = await scan(tab); if (revealed(s)) break;
          // A same-tab click that also triggers navigation, OR one that silently
          // failed (timeout, covered element, e.g. a chat-widget overlay sitting
          // on top of the real Apply link), can leave total unchanged - retry
          // once before giving up on this selector. force:true only skips
          // Playwright's own actionability checks; the dispatched click still
          // hit-tests at that screen position, so a real overlay (HPE's Phenom
          // chatbot) still eats it. A synthetic el.evaluate(e => e.click())
          // invokes the handler directly regardless of what's on top, and is
          // safe here since this is a plain page-navigation link, not one of
          // the extension-observed buttons that require an OS-trusted click.
          if (!revealed(s)) {
            await el.evaluate(e => e.click()).catch(() => {});
            await tab.waitForTimeout(5000);
            s = await scan(tab); if (revealed(s)) break;
          }
          // Some job boards (Lyft/careerpuck -> Greenhouse) embed the REAL form
          // in an iframe instead of navigating or opening a tab. scan()/fillAll()
          // only ever see the top document, so this form was invisible before -
          // it always scored total<5 and got wrongly refused as unfillable.
          // Playwright Frame objects support the same locator()/evaluate() API
          // as Page, so reassigning tab to the frame makes every downstream
          // fill/wizard/submit step below work completely unmodified.
          const frames = (typeof tab.frames === 'function' ? tab.frames() : []).filter(fr => fr !== tab.mainFrame?.());
          for (const fr of frames) {
            const fs2 = await scan(fr).catch(() => null);
            if (fs2 && fs2.total >= 5) { rec.frame = fr.url().slice(0, 100); tab = fr; s = fs2; break; }
          }
          if (revealed(s)) break;
        }
      }
      s = await scan(tab);
      if (!s) {
        rec.status = 'scan-failed';
        // scan() ends in .catch(() => null), so a bare scan-failed threw away the
        // only evidence of what went wrong. Re-probe the page cheaply: if
        // readyState comes back the page is alive and the fault is inside scan's
        // own body; if the probe throws, the tab/frame is dead or detached.
        rec.scanErr = await tab.evaluate(() => document.readyState)
          .then(rs => 'readyState=' + rs)
          .catch(e => String((e && e.message) || e).slice(0, 140));
        rec.scanUrl = (typeof tab.url === 'function' ? tab.url() : '').slice(0, 120);
        return;
      }
      if (s.pw) { rec.status = 'skip-login'; return; }
      // Oracle CandidateExperience gates EVERY application behind an emailed
      // 6-digit PIN: APPLY NOW -> /apply/email -> 'Enter verification code
      // digit N of six' (those 8 entries in gaps.jsonl are this screen). There
      // is no guest path, so it is a login wall in all but name. It was logging
      // as too-sparse-refused because the PIN screen has exactly 2 inputs -
      // primary-email (which we fill) and a honeypot - i.e. the 1/2 seen on 16
      // Oracle jobs this run.
      // Oracle HCM also runs on employer domains (enterpriseplatform.dell.com/
      // hcmUI/CandidateExperience) - key on the path, not the host.
      if (/oraclecloud\.com|\/hcmUI\/CandidateExperience/i.test(tab.url()) && /\/apply\/(email|pin)/i.test(tab.url())) { rec.status = 'skip-login'; return; }
      // Captcha is only a reason to WALK AWAY from a form we could otherwise
      // fill. With no form on screen the reveal simply failed, and calling that
      // 'captcha' hid the real defect - every New York Life job here is an
      // Eightfold SEARCH page (careers/?query=NNNNN) that carries a sitekey div
      // and no application form at all. Report what actually happened.
      if (s.captcha && !allowed(tab.url()) && s.total >= 3) {
        rec.status = 'skip-captcha-visible'; rec.capWhy = s.capWhy; rec.total = s.total; return;
      }
      // An account/login wall (e.g. iCIMS's /login page) commonly renders its
      // actual form inside an iframe or after further JS, so the top document
      // scans as genuinely empty (s.total === 0) and this was misreported as
      // 'no-form-found' instead of the honest, policy-driven 'skip-login'.
      if (!s.total && /\/(login|signin|sign-in)\b/i.test(tab.url())) { rec.status = 'skip-login'; return; }
      // The reveal click can land the LOGIN page inside a frame rather than at
      // the top level (iCIMS does exactly this: the posting and its
      // "Click here to apply" link both live in an iframe, and the click swaps
      // that frame to /login with an email box and an hCaptcha). Checking only
      // tab.url() missed it and the job was filed as no-form-found /
      // too-sparse-refused instead of the honest, policy-driven skip-login.
      {
        const surfUrls = [tab.url(), ...((typeof tab.frames === 'function' ? tab.frames() : []).map(fr => fr.url ? fr.url() : ''))];
        if (s.filled < 3 && surfUrls.some(u => /\/(login|signin|sign-in|register|create-?account)\b/i.test(String(u)))) { rec.status = 'skip-login'; return; }
      }
      {
        const wdUrls = [tab.url(), ...((typeof tab.frames === 'function' ? tab.frames() : []).map(fr => fr.url ? fr.url() : ''))];
        if ((!s.total || s.filled < 3) && wdUrls.some(u => /myworkdayjobs\.com|workdayjobs|workday\.com|\/wday\//i.test(String(u)))) { rec.status = 'skip-workday'; return; }
      }
      if (!s.total) {
        rec.status = 'no-form-found';
        // The only failure status that recorded nothing, so this family was
        // undiagnosable. Captures per-surface bytes/inputs plus the control
        // types BOTH instruments are blind to: the CTA list only matches
        // button/a via has-text, and scan() drops input[type=button], so an
        // <input type=button value="Apply Now"> reads as 'no inputs AND no
        // apply control' in two places at once and looks like an empty page.
        try {
          const surfs = [tab, ...((typeof tab.frames === 'function' ? tab.frames() : []).filter(fr => fr !== tab.mainFrame?.()))];
          rec.frames = [];
          for (const sf of surfs) {
            rec.frames.push(await Promise.race([
              sf.evaluate(() => ({
                url: location.href.slice(0, 200),
                bytes: document.body ? document.body.innerHTML.length : 0,
                inputs: document.querySelectorAll('input,select,textarea').length,
                // Suffix ~ marks NOT RENDERED (no client rects). Without this,
                // dormant zero-size DOM reads as a live blocking overlay.
                ctas: [...document.querySelectorAll('input[type=button],input[type=submit],[role=button],button,a')]
                  .map(e => ((e.value || e.innerText || '').replace(/\s+/g, ' ').trim() + '<' + e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + '>' + (e.getClientRects().length ? '' : '~')))
                  .filter(t => t.length > 4).slice(0, 25),
                visCtas: [...document.querySelectorAll('input[type=button],input[type=submit],[role=button],button,a')]
                  .filter(e => e.getClientRects().length).length,
                text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 300),
              })).catch(() => ({ url: 'unreadable' })),
              new Promise(r => setTimeout(() => r({ url: 'eval-timeout' }), 8000)),
            ]));
          }
        } catch {}
        // A closed/expired posting is not a missing form - retrying it every
        // pass costs a slot for nothing (Lever "Sorry, we couldn't find
        // anything here ... might have closed", 2026-09-24). Terminal.
        if ((rec.frames || []).some(f => /couldn.t find anything here|job not found|job you requested was not found|posting .{0,40}(closed|removed|expired)|no longer (available|accepting|open)|not available anymore|position (has been )?(filled|closed)|job (is )?(closed|expired)|this job (has )?expired|page not found|404 error|error 404/i.test(f.text || '')))
          rec.status = 'skip-closed';
        return;
      }

      // --- resolver-rewrite shadow mode (observe only, changes nothing below) ---
      let shadowPreIR = null, shadowResolved = null;
      if (SHADOW && FACTS) {
        try {
          shadowPreIR = await extractForm(tab);
          await snapshot(shadowPreIR, 'fixtures');
          shadowResolved = await resolve(shadowPreIR, FACTS, { ctx: { jobTitle: rec.title } });
        } catch (e) { rec.shadowErr = String(e.message).slice(0, 80); }
      }

      let unresolved = [];
      {
        const r1 = await fillCycle(tab);
        if (r1.captcha) { rec.status = 'skip-captcha-visible'; rec.capWhy = r1.capWhy; return; }
        unresolved = r1.unresolved;
      }
      // --- agentic pass ---------------------------------------------------
      // Hand EVERY remaining gap to the model in one call, with the real
      // option list and the fact store, then re-fill. This is the part the
      // regex rule list structurally cannot do: it has no access to the
      // question's full wording or its options. 227 jobs in one ledger
      // stopped at this exact point on questions that were either already
      // answered in answers.json or trivially derivable from it.
      if (unresolved.length && LLM_ON && FACTS) {
        if (process.env.DEBUG_TIME) console.error(`[phase] llm-start q=${unresolved.length} +${Math.round((Date.now() - JOB_T0) / 1000)}s`);
        const ans = await askLLM(unresolved, FACTS, { jobTitle: rec.title, ats: rec.ats }).catch(e => {
          rec.llmErr = String(e && e.message || e).slice(0, 60); return new Map();
        });
        let got = 0;
        for (const [k, v] of ans) if (v) { LLM_ANS.set(k, v); got++; }
        rec.llm = { asked: unresolved.length, answered: got };
        // New answers for a real, rendered form: worth finishing. Rippling hit
        // READY at 269-282s and timed out at 240 before the submit (2026-09-24).
        if (got) extendDeadline();
        if (got) {
          const r2 = await fillCycle(tab);
          if (r2.captcha) { rec.status = 'skip-captcha-visible'; rec.capWhy = r2.capWhy; return; }
          unresolved = r2.unresolved;
        }
      }

      // --- resolver-rewrite shadow mode: diff what infer() actually left filled
      // against what resolve() would have filled, for the SAME pre-fill gap set.
      // Only compares fields infer() touched via a rendered option (radio/select) -
      // free-text fields are noisier to align by selector and lower-value to compare.
      if (SHADOW && FACTS && shadowPreIR && shadowResolved) {
        try {
          const postIR = await extractForm(tab);
          const bySelector = new Map(postIR.fields.map(f => [f.selector || f.id, f]));
          const gapsBefore = unresolvedFields(shadowPreIR).filter(f => Array.isArray(f.options) && f.options.length);
          for (const g of gapsBefore) {
            const now = bySelector.get(g.selector || g.id);
            const inferValue = now ? (Array.isArray(now.value) ? now.value.join('; ') : now.value) : null;
            const rf = shadowResolved.fills.find(x => (x.field.selector || x.field.id) === (g.selector || g.id));
            const rg = shadowResolved.gaps.find(x => (x.field.selector || x.field.id) === (g.selector || g.id));
            const resolveValue = rf ? rf.value : null;
            const agree = inferValue && resolveValue ? normShadow(inferValue) === normShadow(resolveValue) : null;
            fs.appendFileSync(SHADOW_LOG, JSON.stringify({
              job_id: j.id, ats: rec.ats, label: g.label, section: g.section,
              infer_value: inferValue || null, resolve_value: resolveValue || null,
              resolve_gap_reason: rg?.reason || null, agree,
            }) + '\n');
          }
        } catch (e) { rec.shadowDiffErr = String(e.message).slice(0, 80); }
      }

      phase('finalscan');
      let fin = await scan(tab);
      // A form that got here filled is worth finishing: submit + the 42s
      // confirmation window + one repair need ~90s, and under 4-worker load
      // Rippling forms reached this point at ~230s and were cut off (09-24).
      if (fin && fin.filled >= 3) extendDeadline();
      rec.filled = fin?.filled; rec.total = fin?.total;
      if (FILE_LOG.length) rec.files = FILE_LOG.slice(0, 4);
      if (AF_LOG.length) rec.extAF = AF_LOG.slice(0, 3);
      if (unresolved.length || (fin && fin.req.length)) {
        const list = unresolved.length ? unresolved : fin.req.slice(0, 3).map(q => ({ q, options: [], required: true }));
        rec.unresolved = list.slice(0, 4);
        fs.appendFileSync(GAPS, JSON.stringify({ id: j.id, title: rec.title, ats: rec.ats, unresolved: rec.unresolved }) + '\n');
      }
      // Bailing out because ONE field was unanswered was the largest single
      // yield loss in the ledger. Most unanswered fields are optional, and
      // the ATS's own validator - not our guess about it - is the authority
      // on what it requires. So record the gap and TRY: a rejected
      // incomplete form costs one page load, while refusing to try costs the
      // entire application. If it does get rejected we land in
      // 'needs-inference' below with the ATS's own error text attached,
      // which is strictly better evidence than the guess was.
      //
      // Floor lowered from 5 to 3: a minimal Greenhouse/Ashby form is
      // name + email + resume, which is a complete, submittable application
      // and was being refused as "too sparse".
      // A wizard walked past step 0 with a real fill on some step has ended on
      // its review/submit page, which naturally has ~1 input. Refusing it as
      // "sparse" threw away a fully answered Activision/Phenom application
      // (1/1 after 3 steps, 2026-09-24).
      const wizDeep = WIZ_TRAIL.some(t => /^[1-9]\d*:/.test(t)) && WIZ_TRAIL.some(t => { const m = String(t).match(/^\d+:(\d+)\/(\d+)/); return m && +m[1] >= 3; });
      if (wizDeep && fin && fin.filled < 3) rec.wizDeep = 1;
      if (!wizDeep && (!fin || fin.filled < 3 || fin.total < 3)) {
        // apply3 had exactly this bug: a 0/0 "sparse" form was really a form
        // that had not finished rendering. Before refusing, give the page up to
        // 20s to grow more inputs, and re-fill if it does. Only re-scan when
        // the count actually changes, so a genuinely bare landing page still
        // refuses immediately after the wait.
        let grew = false;
        for (let k = 0; k < 8; k++) {
          await tab.waitForTimeout(2500);
          const again = await scan(tab);
          if (again && again.total > (fin?.total || 0)) { fin = again; grew = true; }
          if (fin && fin.total >= 3) break;
        }
        if (grew && fin && fin.total >= 3) {
          await fillAll(tab);
          fin = (await scan(tab)) || fin;
          rec.filled = fin?.filled; rec.total = fin?.total;   // keep the record honest after a late render
        }
        if (!fin || fin.filled < 3 || fin.total < 3) {
          // A sparse page that is really a sign-in wall (BCG careerhub ->
          // /candidate/login, 2026-09-25: "Email / Continue / Create an account").
          // Policy says skip-login; judge it from the URL the reveal landed on.
          // The reveal click usually opens the wall in a NEW tab that never
          // became `tab`, so check every page this job opened.
          const LOGIN_RE = /\/(candidate\/)?(login|signin|sign-in|sign_in|register|signup)\b/i;
          const lu = [tab, ...OWN].map(pg => { try { return (pg.url ? pg.url() : '') || ''; } catch { return ''; } }).find(u => LOGIN_RE.test(u)) || '';
          if (lu) { rec.status = 'skip-login'; rec.loginUrl = lu.slice(0, 100); return; }
          rec.status = 'too-sparse-refused';
          rec.sparse = { total: fin?.total ?? null, filled: fin?.filled ?? null, grew };
          return;
        }
      }
      if (!SUBMIT) { rec.status = 'READY'; return; }

      // A chat widget can open itself well after the last fillAll() pass (the
      // only earlier call site), so re-neutralize immediately before hunting
      // for Submit - the exact moment the click actually happens.
      await dismissBanners(tab);

      // Pick a REAL button. Lever ships a 0x0 <button type=submit id=hcaptchaSubmitBtn
      // class=hidden> that precedes the actual one in DOM order, so .first() on a
      // type=submit selector clicks nothing and the failure is swallowed.
      //
      // The button[type=submit] fallback below is exactly what produced false
      // SUBMITTED results, confirmed live twice: (1) a WEX multi-step wizard's
      // "Next" button (id="next", type=submit) advanced step 1 of 6 - the URL
      // changed (step=1 -> step=2), which satisfied the confirmation check, and
      // we reported the job applied after filling out only the first of six
      // steps. (2) On career-portal landing pages (careers.fcsamerica.com,
      // careers.westinghousenuclear.com, jobs.lincolnelectric.com) the fallback
      // grabbed a "Search Jobs" button - a site-search action, not a submit -
      // and the resulting navigation was likewise misread as a successful
      // application. Multi-step wizards are a known, not-yet-built capability
      // gap (see SKILL.md) - until that's built, never let a nav/search button
      // stand in for a real submit; fail honestly instead of guessing.
      // Observed custom-element button tags. Explicit list, not a wildcard:
      // Playwright has no tag-glob, and a blind [class*=button] would match
      // decorative wrappers (see the "interested" hijack above).
      const CE_BTN = 'oc-button, spl-button, sdf-button, ukg-button, adp-button';
      const NAV_NOT_SUBMIT = /^(next|next step|next page|save\s*(and|&)\s*next|continue|continue to application|continue application|save\s*(and|&)\s*continue|back|previous|search\s*jobs?|search)$/i;
      // "Apply With Indeed" / "Apply with LinkedIn" match /apply/ and were being
      // picked as the submit button, which hands the candidate off to a third
      // party instead of submitting the form. Never a submit control.
      const EXTERNAL_APPLY = /\b(with|via)\s+(indeed|linkedin|google|seek|glassdoor)\b/i;
      // Degraded submit paths: these DO submit, but strip the resume we just
      // uploaded. Worse than leaving the job unsubmitted and retrying.
      const DEGRADED_APPLY = /without\s+(a\s+)?(resume|cv)|no\s+resume/i;
      // Walk a wizard that has no Submit on the CURRENT step. Paylocity's step
      // 1 offers only "Next Step" (id=btn-submit, and NOT type=submit), so the
      // hunt below found nothing and 9 jobs died as no-submit-btn with the form
      // already filled. Clicking Next is never treated as success - it only
      // moves us to the next step; SUBMITTED still requires the unchanged
      // CONFIRM_RE / URL / form-gone evidence further down.
      const findSubmit = async () => {
        let el = tab.locator('button:visible, input[type=submit]:visible, [role=button]:visible, ' + CE_BTN.split(', ').map(t => t + ':visible').join(', '))
          .filter({ hasText: /submit|apply|send application/i })
          .filter({ hasNotText: /\b(with|via)\s+(indeed|linkedin|google|seek|glassdoor)\b/i })
          .filter({ hasNotText: /without\s+(a\s+)?(resume|cv)|no\s+resume/i }).last();
        if (await el.count().catch(() => 0)) {
          const t = await el.innerText().catch(() => '');
          const tt = (t || '').replace(/\s+/g, ' ').trim();
          if (!NAV_NOT_SUBMIT.test(tt) && !EXTERNAL_APPLY.test(tt) && !DEGRADED_APPLY.test(tt)) return el;
        }
        el = tab.locator('button[type=submit]:visible, input[type=submit]:visible').last();
        // Phenom's wizard "Next Step" (id=next) IS type=submit; returning it
        // here filed step 1 as a finished submit (Cencora, 2026-09-25) and the
        // wizard walk never ran. A nav label is never the final submit.
        if (await el.count().catch(() => 0)) {
          const t2 = ((await el.innerText().catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
          if (!NAV_NOT_SUBMIT.test(t2)) return el;
        }
        // Custom-element submit, e.g. <oc-button type="primary">Submit</oc-button>
        el = tab.locator(CE_BTN.split(', ').map(t => t + ':visible').join(', '))
          .filter({ hasText: /submit|send application|finish/i })
          .filter({ hasNotText: /\b(with|via)\s+(indeed|linkedin|google|seek|glassdoor)\b/i }).last();
        if (await el.count().catch(() => 0)) return el;
        return null;
      };
      let sb = await findSubmit();
      if (sb) {
        const sbt = ((await sb.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        if (NAV_NOT_SUBMIT.test(sbt)) { WIZ_TRAIL.push('sb-was-next:' + sbt.slice(0, 20)); sb = null; }
      }
      for (let adv = 0; !sb && adv < 4; adv++) {
        phase('wizard:' + adv);
        // hasText with a REGEX matches raw textContent, which is NOT whitespace
        // normalized - an anchored /^next step$/ never matched Paylocity's
        // "\n Next Step\n" button even though it was right there and visible.
        // Normalize in JS instead.
        let nx = null;
        for (const cand of await tab.locator('button:visible, a[role=button]:visible, input[type=button]:visible, [role=button]:visible, ' + CE_BTN.split(', ').map(t => t + ':visible').join(', ')).all().catch(() => [])) {
          const t = ((await cand.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
          if (/^(next|next step|continue|continue to application|continue application|save\s*(and|&)\s*continue)$/i.test(t)) nx = cand;
        }
        if (!nx) { WIZ_TRAIL.push('adv-no-next'); break; }
        if (!await nx.isEnabled().catch(() => false)) { WIZ_TRAIL.push('adv-next-disabled'); break; }
        const sigB = await wizSig(tab);
        await nx.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
        if (!await nx.click({ timeout: 6000 }).then(() => true).catch(() => false))
          await nx.evaluate(e => e.click()).catch(() => {});
        await waitSigChange(tab, sigB);
        if ((await wizSig(tab)) === sigB) {           // refused - fill what it now asks for
          NAV_ERRS = await navErrors(tab);
          await pruneIncompleteRows(tab).catch(() => 0);
          await fillAll(tab);
          await tab.waitForTimeout(1200);
          if (!await nx.click({ timeout: 6000 }).then(() => true).catch(() => false))
            await nx.evaluate(e => e.click()).catch(() => {});
          await waitSigChange(tab, sigB);
          if ((await wizSig(tab)) === sigB) { WIZ_TRAIL.push('adv-stuck' + adv); break; }
        }
        WIZ_TRAIL.push('adv' + adv + ':' + String((await wizSig(tab)) || '').slice(-34));
        extendDeadline();
        await fillAll(tab);
        sb = await findSubmit();
      }
      if (!sb) {
        rec.status = 'no-submit-btn';
        // A bare 'no-submit-btn' said nothing about WHY. Record what the form
        // still wants and which controls it actually offers - that is how
        // Paylocity was identified as a wizard whose only step-1 control is
        // 'Next Step' (id=btn-submit), not a missing-selector problem.
        rec.req = (fin?.req || []).slice(0, 12);
        if (NAV_ERRS.length) rec.navErrs = NAV_ERRS;
        if (WIZ_TRAIL.length) rec.wiz = WIZ_TRAIL.slice(0, 10);
        rec.btns = await tab.evaluate(() =>
          [...document.querySelectorAll('button, input[type=submit], a[role=button]')]
            .filter(e => e.getClientRects().length && e.offsetWidth > 20)
            .map(e => (((e.innerText || e.value || '').replace(/\s+/g, ' ').trim()) + '#' + (e.id || '')).slice(0, 44))
            .filter(t => t !== '#').slice(0, 40)).catch(() => null);
        return;
      }
      rec.sb = await sb.evaluate(e => ({
        text: (e.innerText || e.value || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        id: e.id || '', w: e.offsetWidth, h: e.offsetHeight,
      })).catch(() => null);
      // DO NOT loosen this floor. The 65x11 "Submit" on SmartRecruiters
      // oneclick is FINE PRINT, not the real submit: findSubmit() runs before
      // the advance loop, so clicking it short-circuits the wizard walk that
      // would have reached the real terminal Submit on a later step. Every
      // genuine submit CTA observed across these ATSs is 28-48px tall.
      // Failing honestly as submit-btn-not-visible is strictly better than
      // clicking fine print and reporting submit-unconfirmed.
      // See gotchas.md "Submit size guard: 5px was too loose (2026-09-22)".
      if (!rec.sb || rec.sb.w < 24 || rec.sb.h < 14) { rec.status = 'submit-btn-not-visible'; return; }
      if (NAV_NOT_SUBMIT.test(rec.sb.text.trim())) {
        rec.status = 'skip-multistep-wizard';
        if (NAV_ERRS.length) rec.navErrs = NAV_ERRS;
        if (WIZ_TRAIL.length) rec.wiz = WIZ_TRAIL.slice(0, 10);
        const fin2 = await scan(tab).catch(() => null);
        if (fin2 && fin2.req.length) rec.req = fin2.req.slice(0, 8);
        rec.btns = await tab.evaluate(() =>
          [...document.querySelectorAll('button, input[type=submit], a[role=button]')]
            .filter(e => e.getClientRects().length && e.offsetWidth > 20)
            .map(e => (((e.innerText || e.value || '').replace(/\s+/g, ' ').trim()) + '#' + (e.id || '')).slice(0, 44))
            .filter(t => t !== '#').slice(0, 40)).catch(() => null);
        return;
      }
      await sb.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
      const url0 = tab.url();
      const clickOk = await sb.click({ timeout: 10000 }).then(() => true).catch(() => false);
      if (!clickOk) {
        // Same overlay-interception failure mode as the reveal step (chat
        // widget, extension shadow-root). dismissBanners() already ran right
        // before this, but a widget can re-open in that window - the synthetic
        // click bypasses hit-testing entirely as a last resort, same as the
        // reveal loop's fallback.
        await sb.evaluate(e => e.click()).catch(() => {});
      }
      // A bare URL change is NOT proof of submission - that is exactly what
      // reported SUBMITTED after step 1 of a 6-step WEX wizard and after a
      // career-portal "Search Jobs" click. Accept a URL change only when the
      // form is actually GONE (a wizard step keeps a full form on screen) or
      // the new URL itself names a confirmation page. Text match stays the
      // primary, strongest signal. Window widened to 30s: Ashby and
      // Pinpoint both post asynchronously and were timing out at 21s.
      const CONFIRM_RE = /thank you|thanks for applying|application (received|submitted|complete|sent)|we.{0,3}ve received|successfully (applied|submitted)|your application (has been|was) (received|submitted|sent)|submission (received|successful)|received your application/i;
      // LeverAppId is Lever's own post-submit token and /thanks is its
      // confirmation path; neither contains the words the text regex looks for.
      const CONFIRM_URL_RE = /confirm|thank|success|complete|submitted|applied|LeverAppId/i;
      let ok = false, consentClicked = false;
      // 14 x 3s (was 10): Ashby's "We've received your application" arrived
      // after the 30s window on two jobs that were then filed unconfirmed and
      // retried - one of them may now hold a duplicate application (09-24).
      for (let k = 0; k < 14; k++) {
        await tab.waitForTimeout(3000);
        // safe to read body on an ATS page - no "Applied N" nav counter here
        const st = await tab.evaluate(() => ({
          url: location.href,
          txt: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 5000),
          live: [...document.querySelectorAll('input,select,textarea')].filter(e => {
            const ty = (e.type || e.tagName).toLowerCase();
            return !['hidden', 'submit', 'button'].includes(ty) && (e.offsetWidth > 0 || e.offsetHeight > 0);
          }).length,
        })).catch(() => null);
        // A cross-origin confirmation redirect (Lever -> company.com/confirmation)
        // tears down the execution context, so evaluate() throws WHILE the
        // submission is succeeding. Breaking here reported real applications
        // as submit-unconfirmed - confirmed live on
        // zoox.com/confirmation?LeverAppId=... and lever.co/camstex/.../thanks.
        // tab.url() reads from the browser side and needs no execution
        // context, so it still answers during the navigation.
        if (!st) {
          const u = tab.url();
          if (u !== url0 && CONFIRM_URL_RE.test(u)) {
            ok = true; rec.confirm = 'url-noctx'; rec.confirmUrl = u.slice(0, 120); break;
          }
          continue;   // transient - keep watching, do NOT abandon the check
        }
        // SmartRecruiters opens a "Preliminary questions / privacy notice"
        // step AFTER Submit Application, with its own Back/Submit pair. Nothing
        // clicked it, so a fully filled Arista form sat there unconfirmed
        // (2026-09-25). Accept it once; it only asserts the notice was read.
        if (!consentClicked && /declare that you have read|preliminary questions/i.test(st.txt)) {
          const cbtn = tab.locator('button:visible', { hasText: /^\s*(submit|accept|i agree|agree|confirm)\s*$/i }).last();
          if (await cbtn.count().catch(() => 0)) {
            consentClicked = true;
            rec.consentStep = await cbtn.click({ timeout: 5000 }).then(() => 'clicked').catch(e => String(e.message).slice(0, 50));
            continue;
          }
        }
        const hit = st.txt.match(CONFIRM_RE);
        if (hit) { ok = true; rec.confirm = 'text'; rec.confirmText = hit[0].slice(0, 60); break; }
        if (st.url !== url0) {
          if (st.live < 3) { ok = true; rec.confirm = 'form-gone'; rec.confirmUrl = st.url.slice(0, 120); break; }
          if (CONFIRM_URL_RE.test(st.url)) { ok = true; rec.confirm = 'url'; rec.confirmUrl = st.url.slice(0, 120); break; }
        }
      }
      if (!ok) {
        // Distinguish "the ATS rejected it for missing answers" (fixable by
        // better inference) from "we clicked submit and nothing happened"
        // (fixable by better button/flow handling). Both used to be one bucket.
        rec.status = rec.unresolved ? 'needs-inference' : 'submit-unconfirmed';
        // Ashby's anti-spam refusal ("flagged as possible spam"). A hard block
        // by the site, not a form problem. Terminal: retrying only re-trips it,
        // and working around bot detection is off-limits.
        const spam = await tab.evaluate(() => /flagged as (possible )?spam/i.test(document.body.innerText)).catch(() => false);
        if (spam) { rec.status = 'skip-spam-flagged'; return; }
        // Employer-side quota ("We currently allow candidates to apply to 5
        // roles every 90 days" - Rivian on Ashby). Also a hard, terminal no.
        const quota = await tab.evaluate(() => /allow candidates to apply to \d+ roles|application limit|maximum number of applications/i.test(document.body.innerText)).catch(() => false);
        if (quota) { rec.status = 'skip-apply-limit'; return; }
        // Second chance: the ATS has just NAMED the field it is missing. Fill
        // it from the bank/learned.json and click submit once more before
        // giving up. Ashby refused fully-filled forms over a single field we
        // already had the answer to ("Email", "How did you hear about us?").
        const rep = await repairFromErrors(tab).catch(() => ({ fixed: 0, named: [] }));
        if (rep.named.length) rec.repair = rep;
        if (rep.fixed) {
          if (!await sb.click({ timeout: 8000 }).then(() => true).catch(() => false))
            await sb.evaluate(e => e.click()).catch(() => {});
          await tab.waitForTimeout(9000);
        }
        rec.diag = await tab.evaluate(() => {
          const clean = t => (t || '').replace(/\s+/g, ' ').trim();
          const vis = e => e.offsetWidth > 0 && e.offsetHeight > 0;
          // validation messages the ATS surfaced
          const errs = [...document.querySelectorAll('[aria-invalid="true"],[class*=error],[class*=invalid],[role=alert]')]
            .filter(vis).map(e => clean(e.innerText).slice(0, 110)).filter(Boolean);
          // fields the ATS marks required by CLASS or by a glyph, not the attribute
          const blanks = [];
          document.querySelectorAll('[class*=required], fieldset, .application-question').forEach(box => {
            const t = clean(box.innerText);
            if (!/[*\u2731]/.test(t)) return;
            const f = box.querySelector('input,select,textarea');
            if (!f) return;
            const ty = (f.type || '').toLowerCase();
            let empty;
            if (ty === 'radio' || ty === 'checkbox') empty = ![...box.querySelectorAll('input')].some(x => x.checked);
            else if (ty === 'file') empty = !(f.files && f.files.length);
            else empty = !String(f.value || '').trim();
            if (empty) blanks.push(t.slice(0, 100));
          });
          // Visible challenge frames / disabled submit: an Ashby submit that
          // "does nothing" with zero errors (opengov, base-power, 2026-09-24)
          // is either a captcha challenge or a button still disabled/pending.
          const chal = [...document.querySelectorAll('iframe')].filter(f => /captcha|challenge|turnstile|recaptcha/i.test(f.src || f.title || ''))
            .map(f => { const r = f.getBoundingClientRect(); return `${(f.src || f.title).slice(0, 60)}@${Math.round(r.width)}x${Math.round(r.height)}${getComputedStyle(f).visibility === 'hidden' ? ':hidden' : ''}`; }).slice(0, 4);
          const sbState = [...document.querySelectorAll('button')].filter(b => /submit/i.test(b.innerText)).map(b => `${clean(b.innerText).slice(0, 25)}|dis=${b.disabled}|aria=${b.getAttribute('aria-disabled')}|busy=${b.getAttribute('aria-busy')}`).slice(0, 3);
          return { url: location.href, errs: [...new Set(errs)].slice(0, 6),
                   blanks: [...new Set(blanks)].slice(0, 10), body: clean(document.body.innerText).slice(0, 600),
                   chal, sbState, tail: clean(document.body.innerText).slice(-300) };
        }).catch(() => null);
        // The 30s confirmation window can close MID-REDIRECT. Lever bounces
        // cross-origin to company.com/confirmation?LeverAppId=... and the proof
        // then lands in the diag we capture a moment later - so a real
        // submission got filed as submit-unconfirmed with its own confirmation
        // URL sitting unread in the record (zoox.com/confirmation?LeverAppId).
        // Re-test that final snapshot before declaring failure.
        // Deliberately STRICTER than the in-loop url branch (which accepts a
        // bare "form is gone"): require the URL to have actually changed, to
        // name a confirmation page or carry confirmation text, AND for the ATS
        // to be reporting no validation errors. False SUBMITTED is the one
        // outcome worse than a missed application - see gotchas.md.
        const d = rec.diag;
        if (d && d.url && !(d.errs || []).length
            && ((d.url !== url0 && CONFIRM_URL_RE.test(d.url)) || CONFIRM_RE.test(d.body || "") || /received your application|we.{0,3}ve received your|thanks for applying|application (has been |was )?(received|submitted)/i.test(d.tail || ""))) {
          rec.status = "SUBMITTED"; sub++;
          rec.confirm = "late-diag"; rec.confirmUrl = d.url.slice(0, 120);
          try { fs.mkdirSync("proof", { recursive: true }); await tab.screenshot({ path: `proof/${j.id}.png`, timeout: 8000 }); rec.proof = 1; } catch {}
          const yesLate = p.locator('button:has-text("Yes, I applied")').first();
          if (await yesLate.count().catch(() => 0)) await yesLate.click({ timeout: 6000 }).then(() => rec.marked = 1).catch(() => {});
          return;
        }
        return;
      }
      rec.status = 'SUBMITTED'; sub++; phase('submitted');
      // Independent evidence, so a SUBMITTED claim can be audited later
      // without revisiting the site (where many ATSs render a blank form
      // again and prove nothing either way).
      try { fs.mkdirSync('proof', { recursive: true }); await tab.screenshot({ path: `proof/${j.id}.png`, timeout: 8000 }); rec.proof = 1; } catch {}
      const yes = p.locator('button:has-text("Yes, I applied")').first();
      if (await yes.count().catch(() => 0)) await yes.click({ timeout: 6000 }).then(() => rec.marked = 1).catch(() => {});
    })(), JOB_TIMEOUT);
  } catch (e) {
    jobCrashed = true;
    const msg = String(e.message || e);
    rec.status = 'err:' + msg.slice(0, 40);
    // A bare err:timeout said nothing about where 6 minutes went. PHASE is set
    // as the job proceeds, so it survives the abort.
    rec.phase = PHASE;
    rec.elapsed = Math.round((Date.now() - JOB_T0) / 1000);
    if (DEAD_BROWSER.test(msg)) {
      deadStreak++;
      console.log(`  [browser connection died (streak ${deadStreak}), reconnecting: ${msg.slice(0, 60)}]`);
      const ok = await reconnect();
      // In-process reconnect (a fresh connectOverCDP call) does not reliably
      // clear this - confirmed live: the very next job died the identical way
      // even after reconnect() verified a working newPage(). Rather than burn
      // through the rest of the queue hitting the same wall on every single
      // remaining job (each costs a full ~150s timeout), exit non-zero once
      // it's clearly not recovering. The wrapper script (run_offsite_resilient.sh)
      // restarts as a brand-new OS process, which - unlike an in-process
      // reconnect - has no stale Playwright Browser object at all.
      if (!ok || deadStreak >= 2) {
        console.log('browser connection unrecoverable in-process, exiting for wrapper restart');
        fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
        process.exit(1);
      }
    }
  }
  if (!jobCrashed) deadStreak = 0;
  if (tab && typeof tab.isClosed === 'function') OWN.add(tab);
  try { for (const pg of c.pages()) { if (pg !== p && !pg.isClosed() && pg.url().includes(`jr_id=${j.id}`)) await pg.close().catch(() => {}); } } catch {}
  try { for (const pg of c.pages()) { if (pg === p || pg.isClosed()) continue; const op = await pg.opener().catch(() => null); if (OWN.has(pg) || (op && OWN.has(op))) await pg.close().catch(() => {}); } } catch {}
  try { if (p && !p.isClosed()) await p.close(); } catch {}
  if (ANS_LOG.length) rec.answers = [...new Set(ANS_LOG)];
  fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
  console.log(`[${n}/${queue.length}] ${String(rec.status).padEnd(21)} ${rec.filled ?? '-'}/${rec.total ?? '-'} ${rec.marked ? 'MARKED ' : ''}${rec.title.slice(0, 40)}`);
}
console.log(`\nprocessed=${n} submitted=${sub}`);
// b.close() over CDP can hang forever; a finished run then lingers and
// shares Chrome with the next pass (2026-09-23). Cap it and exit.
await Promise.race([b.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
process.exit(0);
