/**
 * resolve.mjs — (FormIR, FactStore) -> Fill[]
 *
 * Pure function of its inputs. No DOM, no network except the one batched
 * model call. Runnable against fixtures/ with zero browser.
 *
 *   Stage 1  question text  -> canonical fact key   (regex / cache)
 *   Stage 2  fact value     -> a rendered option    (needs the DOM options)
 *
 * Stage 2 is the one question-text regex can never do, and is where the
 * old infer() was losing.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { factLookup } from './resolve-patch.mjs';

// ---------------------------------------------------------------- cache

const norm = (s) => (s || '').toLowerCase().replace(/[*✱＊]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Cache key includes the OPTIONS, not just the question. Same question with
// different option sets is a different problem and gets its own entry.
const cacheKey = (f) => {
  const opts = Array.isArray(f.options) ? f.options.map(o => norm(o.label)).sort().join('|') : String(f.options ?? '');
  return crypto.createHash('sha1').update(`${norm(f.section)}::${norm(f.label)}::${f.control}::${opts}`).digest('hex').slice(0, 16);
};

export async function loadCache(p = './learned.json') {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return {}; }
}
export async function saveCache(cache, p = './learned.json') {
  await fs.writeFile(p, JSON.stringify(cache, null, 2));
}

// ---------------------------------------------- stage 1: canonical keys

// Maps question text -> a key in the fact store. Regex is fine HERE because
// it's only classifying topic, never choosing an answer.
const CANON = [
  ['sponsorship',    /sponsor|visa status|h-?1b|require.*(sponsor|visa)|immigration/i],
  ['work_auth',      /legally (authorized|entitled)|authorized to work|work authorization|right to work|eligible to work/i],
  ['first_name',     /^(first|given)\s*name/i],
  ['last_name',      /^(last|family|sur)\s*name/i],
  ['full_name',      /^(full\s*)?name$|^your name/i],
  ['email',          /e-?mail/i],
  ['phone',          /phone|mobile|telephone/i],
  ['linkedin',       /linked\s*in/i],
  ['github',         /git\s*hub/i],
  ['portfolio',      /portfolio|personal (site|website)|website/i],
  ['resume',         /resume|cv\b/i],
  ['cover_letter',   /cover letter/i],
  ['location',       /current (location|city)|where are you (located|based)|city|address/i],
  ['relocate',       /willing to relocate|open to relocat/i],
  ['remote_pref',    /remote|hybrid|on-?site|work (setting|arrangement)/i],
  ['comp_expect',    /salary|compensation|pay (expectation|range)|desired (pay|rate)|hourly rate/i],
  ['start_date',     /start date|available(ility)? to start|when can you (start|begin)|notice period/i],
  ['grad_year',      /graduat|expected (completion|end)|year of (completion|graduation)/i],
  ['school',         /school|university|college|institution/i],
  ['degree',         /degree|qualification level/i],
  ['major',          /major|field of study|discipline|concentration/i],
  ['gpa',            /gpa|grade point/i],
  ['gender',         /gender/i],
  ['race',           /race|ethnic/i],
  ['veteran',        /veteran|protected veteran|military/i],
  ['disability',     /disab|section 503/i],
  ['hispanic',       /hispanic|latino/i],
  ['referral',       /how did you hear|referred by|source|referral/i],
  ['prev_employee',  /previously (worked|employed)|former employee|worked (here|at)/i],
  ['age_18',         /(18|eighteen) years|over 18|at least 18/i],
  ['bg_check',       /background check|drug (test|screen)/i],
];

// Ordering guards: same topic, opposite polarity. Check the narrower first.
// (This is the ONLY place ordering matters, and it's declarative now.)
const PRECEDENCE = [['sponsorship', 'work_auth']];

export function canonKey(field) {
  const hay = `${field.label} ${field.help || ''}`;
  const hits = CANON.filter(([, re]) => re.test(hay)).map(([k]) => k);
  if (!hits.length) return null;
  for (const [winner, loser] of PRECEDENCE) {
    if (hits.includes(winner) && hits.includes(loser)) return winner;
  }
  return hits[0];
}

// ------------------------------------------- stage 2: value -> option

/** Score how well a fact value matches a rendered option label. */
function matchOption(factValue, options) {
  const v = norm(String(factValue));
  const scored = options.map(o => {
    const l = norm(o.label);
    let s = 0;
    if (l === v) s = 100;
    else if (l.startsWith(v) || v.startsWith(l)) s = 80;
    else if (l.includes(v) || v.includes(l)) s = 60;
    // yes/no fuzz — "Yes, I am authorized" should match true
    if (/^(true|yes)$/.test(v) && /^yes\b/.test(l)) s = Math.max(s, 90);
    if (/^(false|no)$/.test(v) && /^no\b/.test(l)) s = Math.max(s, 90);
    return { option: o, score: s };
  }).sort((a, b) => b.score - a.score);

  const [top, next] = scored;
  if (!top || top.score < 60) return null;
  // ambiguous if the runner-up is close — escalate rather than coin-flip
  if (next && top.score - next.score < 20) return null;
  return top.option;
}

// ------------------------------------------------------------ policy

const DEFAULT_POLICY = {
  // must come from the fact store verbatim; never modeled, never guessed
  never_infer: ['work_auth', 'sponsorship', 'citizenship', 'veteran', 'disability', 'race', 'gender', 'hispanic', 'gpa', 'grad_year', 'degree', 'school'],
  min_confidence: 0.8,
};

/** Pick the right education row using section context. Fixes HS-vs-degree. */
function educationValue(facts, key, field) {
  const ctx = norm(`${field.section} ${field.label}`);
  const rows = facts.education || [];
  const want = /high school|secondary/.test(ctx) ? 'high_school'
    : /master|graduate|phd|doctora/.test(ctx) ? 'masters'
    : 'bachelors';
  const row = rows.find(r => r.level === want) || rows[rows.length - 1];
  if (!row) return undefined;
  return { grad_year: row.end_year, school: row.school, degree: row.level, major: row.major, gpa: row.gpa }[key];
}

// ------------------------------------------------------------ resolve

export async function resolve(ir, facts, opts = {}) {
  const policy = { ...DEFAULT_POLICY, ...(facts.policy || {}), ...(opts.policy || {}) };
  const cache = opts.cache || {};
  const fills = [];
  const gaps = [];
  const needsModel = [];

  for (const field of ir.fields) {
    const needed = field.error ||
      (field.control === 'radio' || field.control === 'checkbox' ? !field.value?.length : field.empty);
    if (!needed || !field.required) continue;

    const ck = cacheKey(field);

    // --- cached: free, deterministic, highest priority ---
    if (cache[ck]) {
      fills.push({ ...cache[ck], field, source: 'learned', confidence: 1 });
      continue;
    }

    // --- fact store via canonical key ---
    // factLookup (resolve-patch.mjs) supersedes the bare facts[key] lookup:
    // term-aware start_date, unit-aware comp_expect, GPA-scale-aware
    // education, and the closed agreeable_allowlist fallback. Without this,
    // resolve-patch.mjs is dead code and none of its fixes take effect.
    const key = canonKey(field);
    if (key) {
      const looked = factLookup(facts, key, field, opts.ctx || {});
      const raw = looked?.raw;
      const source = looked?.source || 'bank';

      if (raw !== undefined && raw !== null && raw !== '') {
        if (Array.isArray(field.options) && field.options.length) {
          const opt = matchOption(raw, field.options);
          if (opt) {
            fills.push({ field, action: 'select', value: opt.label, selector: opt.selector || field.selector, source, source_key: key, confidence: 1, cacheKey: ck });
            continue;
          }
          // stage 2 failed: we know the fact, can't map it to these options.
          // THIS is the case the old regex resolver silently fumbled.
          if (policy.never_infer.includes(key)) {
            gaps.push({ field, key, raw, reason: 'never_infer key has no confident option match' });
            continue;
          }
          needsModel.push({ field, key, raw, cacheKey: ck });
          continue;
        }
        fills.push({ field, action: 'fill', value: String(raw), selector: field.selector, source, source_key: key, confidence: 1, cacheKey: ck });
        continue;
      }

      if (policy.never_infer.includes(key)) {
        gaps.push({ field, key, reason: 'never_infer key missing from fact store' });
        continue;
      }
    }

    needsModel.push({ field, key, cacheKey: ck });
  }

  // --- one batched model call for everything left ---
  if (needsModel.length && opts.ask) {
    const answers = await opts.ask(buildPrompt(ir, facts, needsModel));
    for (const item of needsModel) {
      const a = answers?.find(x => x.field_id === item.field.id);
      if (!a || a.action === 'skip') { gaps.push({ field: item.field, reason: a?.note || 'model declined' }); continue; }
      if ((a.confidence ?? 0) < policy.min_confidence) { gaps.push({ field: item.field, reason: `low confidence ${a.confidence}` }); continue; }
      // hard validation: a select/radio answer MUST be a real rendered option
      if (Array.isArray(item.field.options) && item.field.options.length) {
        const opt = item.field.options.find(o => norm(o.label) === norm(a.value));
        if (!opt) { gaps.push({ field: item.field, reason: `hallucinated option "${a.value}"` }); continue; }
        fills.push({ field: item.field, action: 'select', value: opt.label, selector: opt.selector || item.field.selector, source: 'model', confidence: a.confidence, cacheKey: item.cacheKey });
        continue;
      }
      fills.push({ field: item.field, action: 'fill', value: a.value, selector: item.field.selector, source: 'model', confidence: a.confidence, cacheKey: item.cacheKey });
    }
  } else if (needsModel.length) {
    gaps.push(...needsModel.map(m => ({ field: m.field, reason: 'no resolver available' })));
  }

  // promote confident resolutions into the cache
  for (const f of fills) {
    if (f.cacheKey && f.source !== 'learned' && (f.confidence ?? 0) >= policy.min_confidence) {
      cache[f.cacheKey] = { action: f.action, value: f.value, selector: f.selector };
    }
  }

  return { fills, gaps, cache, coverage: fills.length / Math.max(1, fills.length + gaps.length) };
}

// ------------------------------------------------------------ prompt

function buildPrompt(ir, facts, items) {
  return {
    system:
      'You map job-application form fields to values from a fact store. ' +
      'You may ONLY use values derivable from the provided facts. Never invent employment, ' +
      'education, credentials, dates, or numbers. If a field is not derivable, return action "skip" ' +
      'with a note. For fields with options, "value" MUST be copied verbatim from the provided ' +
      'options list. Reply with JSON only: ' +
      '[{"field_id":"...","action":"fill"|"select"|"skip","value":"...","source_key":"...","confidence":0.0-1.0,"note":"..."}]',
    user: JSON.stringify({
      page: { url: ir.url, title: ir.title, step: ir.step },
      // whole-form context: this is what disambiguates a bare "Year" or "Start Date"
      form_context: ir.fields.map(f => ({ label: f.label, section: f.section, value: f.value })),
      facts,
      fields: items.map(i => ({
        field_id: i.field.id,
        label: i.field.label,
        section: i.field.section,
        help: i.field.help,
        control: i.field.control,
        options: Array.isArray(i.field.options) ? i.field.options.map(o => o.label) : i.field.options,
        validation_error: i.field.error,
        guessed_topic: i.key,
      })),
    }, null, 2),
  };
}

// ---------------------------------------------------- offline replay

/** node resolve.mjs fixtures/  — regression-test the resolver with no browser. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || './fixtures';
  const facts = JSON.parse(await fs.readFile(process.argv[3] || './answers.json', 'utf8'));
  const cache = await loadCache();
  let tot = 0, ok = 0;
  for (const file of (await fs.readdir(dir)).filter(f => f.endsWith('.json'))) {
    const ir = JSON.parse(await fs.readFile(`${dir}/${file}`, 'utf8'));
    const r = await resolve(ir, facts, { cache });
    tot += r.fills.length + r.gaps.length; ok += r.fills.length;
    console.log(`${file.padEnd(44)} ${r.fills.length}/${r.fills.length + r.gaps.length}`);
    for (const g of r.gaps) console.log(`    GAP  ${g.field.label?.slice(0, 60)} — ${g.reason}`);
  }
  console.log(`\ncoverage ${ok}/${tot} (${(100 * ok / Math.max(1, tot)).toFixed(1)}%)`);
}
