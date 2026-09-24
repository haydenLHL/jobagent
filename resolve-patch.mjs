/**
 * resolve-patch.mjs — drop-in replacements for resolve.mjs.
 *
 * Three fixes driven by the real fact store:
 *   1. start_date  — pick winter/summer from the job title, not a fixed default
 *   2. comp_expect — detect hourly vs annual from the field label
 *   3. agreeable   — closed allowlist, so capability questions can never default
 */

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- 1. term

/**
 * Pass the JobRight job title through as ctx.jobTitle. Your queue already
 * has it; the form IR never will.
 */
export function startDateValue(facts, field, ctx = {}) {
  const hay = norm(`${ctx.jobTitle} ${ctx.jobDescription} ${field.section} ${field.label} ${ctx.pageTitle}`);

  if (/\bsummer\b|\bmay\s*(20)?\d{2}\s*start|\bjune\b/.test(hay)) return facts.start_date_summer;
  if (/\bwinter\b|\bjanuary\b|\bjan\s*(20)?\d{2}\b|\bspring\b/.test(hay)) return facts.start_date_winter;
  if (/\bfall\b|\bautumn\b|\bseptember\b/.test(hay)) return facts.start_date_fall || facts.start_date_default;

  // Year mentioned without a term: keep the year, keep the default month.
  const yr = hay.match(/\b(20[2-3]\d)\b/);
  if (yr && facts.start_date_default) {
    return facts.start_date_default.replace(/^\d{4}/, yr[1]);
  }
  return facts.start_date_default;
}

// ------------------------------------------------------------------ 2. comp

const HOURLY = /hour|hourly|\/\s*hr\b|per hour|rate\b/i;
const MONTHLY = /month|monthly|per month|\/\s*mo\b/i;
const RANGE = /range|minimum|maximum|from.*to|low.*high/i;

/** Returns { value, unit } so the caller can log what unit it assumed. */
export function compValue(facts, field) {
  const hay = `${field.label} ${field.help || ''} ${field.section || ''}`;
  const wantsRange = RANGE.test(hay);
  const numeric = field.control === 'number' || /^\d+$/.test(String(field.value || ''));

  if (HOURLY.test(hay)) {
    return {
      value: wantsRange && !numeric ? facts.comp_expect_hourly_range : facts.comp_expect_hourly,
      unit: 'hourly',
    };
  }
  if (MONTHLY.test(hay)) {
    const monthly = Math.round(facts.comp_expect_annual / 12);
    return { value: monthly, unit: 'monthly' };
  }
  // No unit in the label. For an internship posting this is genuinely
  // ambiguous — gap rather than guess a 2000x-wrong number.
  if (!/salary|annual|year|yearly|compensation|total comp/i.test(hay)) {
    return { value: undefined, unit: 'ambiguous' };
  }
  return {
    value: wantsRange && !numeric ? facts.comp_expect_annual_range : facts.comp_expect_annual,
    unit: 'annual',
  };
}

// ------------------------------------------------------------- 3. agreeable

const NEVER_AGREEABLE_PATTERNS = [
  /\b\d+\+?\s*(years?|yrs?)\b/i,                       // "3+ years of ..."
  /years of experience|experience with|proficien|expert|familiar with/i,
  /certifi|licensed|credential/i,
  /currently enrolled|are you pursuing|degree in progress/i,
  /terminated|dismissed|fired|disciplin|resign/i,
  /fluent|native speaker|language proficiency/i,
  /have you ever (worked|been employed|held)/i,
];

/**
 * Agreeable defaults apply ONLY to an explicit canonical key on the
 * allowlist. Anything matching a capability/credential shape is refused
 * even if it somehow canonicalized onto an allowlisted key.
 */
export function agreeableDefault(facts, field, key) {
  const policy = facts.policy || {};
  const allow = policy.agreeable_allowlist || {};
  if (!key || !(key in allow)) return undefined;

  const hay = `${field.label} ${field.help || ''}`;
  if (NEVER_AGREEABLE_PATTERNS.some(re => re.test(hay))) return undefined;
  if ((policy.never_agreeable || []).includes(key)) return undefined;

  return allow[key];
}

// ------------------------------------------------------- wiring into resolve

/**
 * In resolve(), replace the bare `facts[key]` lookup with this.
 * Returns { raw, source, unit? } or undefined.
 */
export function factLookup(facts, key, field, ctx = {}) {
  if (key === 'start_date') {
    const v = startDateValue(facts, field, ctx);
    return v === undefined ? undefined : { raw: v, source: 'bank' };
  }
  if (key === 'comp_expect') {
    const { value, unit } = compValue(facts, field);
    return value === undefined
      ? undefined                                   // ambiguous unit -> gap
      : { raw: value, source: 'bank', unit };
  }
  if (['grad_year', 'school', 'degree', 'major', 'gpa'].includes(key)) {
    const ctxStr = norm(`${field.section} ${field.label}`);
    const rows = facts.education || [];
    const want = /high school|secondary/.test(ctxStr) ? 'high_school'
      : /master|graduate|phd|doctora/.test(ctxStr) ? 'masters'
      : 'bachelors';
    const row = rows.find(r => r.level === want) || rows.at(-1);
    if (!row) return undefined;
    // GPA scale matters: most US forms assume /4.0
    const gpa = /4\.?0|four point|out of 4/i.test(field.label) ? row.gpa_4_scale : row.gpa;
    const v = { grad_year: row.end_year, school: row.school, degree: row.degree, major: row.major, gpa }[key];
    return (v === undefined || v === null || String(v).startsWith('TODO')) ? undefined : { raw: v, source: 'bank' };
  }

  const direct = facts[key];
  if (direct !== undefined && direct !== null && direct !== '' && !String(direct).startsWith('TODO')) {
    return { raw: direct, source: 'bank' };
  }
  const agree = agreeableDefault(facts, field, key);
  return agree === undefined ? undefined : { raw: agree, source: 'agreeable' };
}
