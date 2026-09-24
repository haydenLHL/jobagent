// Agentic gap resolver. Called once per form with every unresolved field.
// Uses the logged-in `claude` CLI headless (no API key needed). Answers are
// cached on disk so a repeated question costs nothing on later jobs.
//
// Contract: returns a Map of normalized-question -> answer string (or null).
// An answer of null means "not derivable from the facts" - the caller must
// leave the field blank and log a gap. NEVER invent credentials.
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';

const CACHE_FILE = 'llm_cache.json';
const LOG = 'llm.jsonl';
export const norm = s => (s || '').toLowerCase().replace(/[*✱＊]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
const key = (q, opts) => norm(q) + '||' + (opts || []).map(o => String(o).trim()).join('|').toLowerCase().slice(0, 200);

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
const saveCache = () => { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1)); } catch {} };

// A null must be cacheable (a Lever language matrix asks 33 unanswerable
// questions on EVERY such form, and re-asking them each time costs a minute
// per job) but must NOT be permanent - that is what poisoned the first test
// run, where an improved prompt could never override a cached refusal. Key
// nulls by a version hash of the prompt AND the fact store, so any change to
// either invalidates exactly the refusals it might have fixed.
let VER = null;
const nullKey = (k, facts) => {
  if (!VER) VER = crypto.createHash('sha1').update(SYS + JSON.stringify(facts || {})).digest('hex').slice(0, 10);
  return 'NULL@' + VER + '||' + k;
};

// Strip an inherited ANTHROPIC_API_KEY and the parent session's CLAUDE_CODE_*
// vars. When the scripts are launched from inside a Claude Code session, the
// child `claude -p` inherits that session's key, and it hung until
// LLM_TIMEOUT_MS on every call: 178 of 200 calls came back raw "null" and each
// burned 2 minutes of a job's budget (2026-09-24). Without them it uses the
// claude.ai login and answers in ~2s.
const CHILD_ENV = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => k !== 'ANTHROPIC_API_KEY' && !k.startsWith('CLAUDE_CODE_')));
const run = (args, stdin, ms) => new Promise(res => {
  const ch = execFile('claude', args, { maxBuffer: 8 << 20, timeout: ms, env: CHILD_ENV }, (err, so) => res(err && !so ? null : so));
  if (stdin) { ch.stdin.write(stdin); ch.stdin.end(); }
});

const SYS = `You fill out job-application forms for one specific candidate. You are given FACTS about the candidate and a list of form questions. Answer ONLY from the FACTS.

RULES, in priority order:
1. If a question has OPTIONS, your answer MUST be one of the option strings, copied EXACTLY (character for character). If no option is truthful, answer null.
2. If a question has no OPTIONS, answer with a short plain string suitable for typing into the field.
3. Answer null whenever the truthful answer is not derivable from the FACTS. Never guess a credential, a qualification, a years-of-experience number, a proficiency level, a certification, an employment history claim, a security clearance, or any identity/demographic fact that is not in FACTS.
3a. But distinguish a CREDENTIAL from a PREFERENCE. A preference question (start date, which term, which role/track/team, which office, how much travel, remote vs onsite, how did you hear about us) has no true-or-false answer: pick the closest reasonable option from FACTS and the job title. Answering null on a preference question is a mistake - it blocks the whole application over something that was never a factual claim. Reserve null for questions where a wrong answer would be a false statement about the candidate.
3b. A question whose exact expected value is absent from the options but which is a preference (e.g. FACTS says a 2027 start and the form offers only 2026 months) is still a preference: follow FACTS.start_date_policy / FACTS.role_preference rather than answering null.
3c. HARD RULE, no exceptions: a start-date / earliest-availability / which-term / which-role / which-office / how-did-you-hear-about-us question that has OPTIONS must never be answered null. Pick the best option per FACTS.start_date_policy and FACTS.role_preference. Answering null there is the single most costly mistake you can make, because it blocks an otherwise complete application over a negotiable preference.
4. Work authorization, sponsorship and citizenship: use the FACTS verbatim; they are deliberate. The candidate is a Canadian citizen, NOT authorized to work in the US, and DOES require sponsorship. Watch for inverted phrasing - answer the question that was actually asked.
5. EEO / self-identification / veteran / disability / gender / race: always pick the option that declines to answer. If none exists, answer null.
5a. Language fluency: FACTS.languages is authoritative for the languages it lists. For a language NOT listed there, answer null - never assert that the candidate does or does not speak it.
5b. School / degree / major pickers sometimes have a machine-generated label like "cards[uuid][field0]" and a very long option list that has been TRUNCATED before reaching you. If the options look like a list of universities, degrees or majors, answer with FACTS.education[0].school / .degree / .major verbatim even when that exact string is not among the options you can see - the caller matches it against the full list.
6. Consent, acknowledgement, terms, privacy, background-check, drug-screen, relocation, travel, onsite, age-18 questions: answer affirmatively.
7. Questions about prior employment at the company, relatives at the company, non-competes, criminal convictions, competing offers: answer negatively.
8. Free-text questions ("why do you want to work here", "what skills would you bring", "describe a project"): if "required" is false, answer null - do not volunteer an essay. If "required" is true, the application cannot be submitted without it, so DO answer: 2-4 plain sentences, first person, drawn ONLY from FACTS.resume_text / FACTS.skills / FACTS.work_history. Every concrete claim must be traceable to that text. No superlatives, no invented interests, no company research you do not have.
8a. A REQUIRED "Why <company>?" / "Why do you want to join/work at <company>?" / "Why this role?" question is NOT a reason to answer null. Having no facts about the company is expected: answer about the ROLE instead - connect the candidate's actual experience (FACTS.work_history / FACTS.skills / FACTS.resume_text) to the job_title, and state interest in applying those skills there. Mention the company only by name. Never state facts, products, values or news about the company.
9. A verification/OTP code, or anything requiring information only the employer has: null.
10. Address/contact fields (country, state, province, city, postal/zip, county, phone type) refer to the CANDIDATE'S OWN address in FACTS - answer them from FACTS.address_line1/city/state_province/postal_code/country. Only answer null if the truthful value is genuinely absent from FACTS or absent from the options.
11. "Preferred work location" / "which offices interest you" is a preference, not a fact about where the candidate lives: prefer an option meaning any/no-preference/flexible, else the option matching a major US tech hub, else null.
12. Start-date questions: FACTS.start_date_default unless the question names a season, then use the matching start_date_* key. Never choose an option that is already in the past relative to "today" in the input. If EVERY offered option is in the past, the posting is stale - answer null.

Output STRICT JSON and nothing else:
{"answers":[{"i":<question index>,"a":<string or null>,"why":"<=12 words"}]}`;

export async function askLLM(questions, facts, ctx = {}) {
  const out = new Map();
  const need = [];
  for (const q of questions) {
    const k = key(q.q, q.options);
    if (k in cache) { out.set(norm(q.q), cache[k]); continue; }
    if (nullKey(k, facts) in cache) { out.set(norm(q.q), null); continue; }
    // A label with no real question in it ("\u200b Required", "*") cannot be
    // answered by anyone. Don't spend a model call on it; it stays a gap.
    const residue = String(q.q || '').replace(/[\u200b\u2731\u273D\uFF0A*]/g, ' ')
      .replace(/\b(required|optional|this field is required)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if (residue.length < 4) { out.set(norm(q.q), null); continue; }
    need.push({ k, q });
  }
  if (!need.length) return out;
  // Cap the batch. A 40-question call takes well over a minute, which pushed
  // whole jobs past their deadline and lost work that was already done.
  // Required fields are what actually block a submission, so they go first.
  const MAX_Q = Number(process.env.LLM_MAX_Q || 24);
  need.sort((a, b) => (b.q.required ? 1 : 0) - (a.q.required ? 1 : 0));
  const dropped = need.slice(MAX_Q);
  need.length = Math.min(need.length, MAX_Q);
  for (const d of dropped) out.set(norm(d.q.q), null);

  const payload = {
    // Without today's date the model reasons about "2026 start" options
    // relative to its training cutoff and either picks a date already in the
    // past or refuses a perfectly good one.
    today: new Date().toISOString().slice(0, 10),
    job_title: ctx.jobTitle || '', ats: ctx.ats || '',
    facts,
    questions: need.map((n, i) => ({ i, question: String(n.q.q || '').slice(0, 400), required: !!n.q.required,
                                     options: (n.q.options || []).map(o => String(o).slice(0, 120)).slice(0, 60) })),
  };
  const args = ['-p', '--output-format', 'json', '--model', process.env.LLM_MODEL || 'sonnet',
                '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
                '--allowed-tools', '', '--append-system-prompt', SYS];
  const raw = await run(args, JSON.stringify(payload), Number(process.env.LLM_TIMEOUT_MS || 120000));
  let answers = [];
  try {
    const env = JSON.parse(raw);
    const txt = String(env.result || '');
    const m = txt.match(/\{[\s\S]*\}/);
    answers = JSON.parse(m ? m[0] : txt).answers || [];
  } catch (e) {
    try { fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), err: 'parse', raw: String(raw).slice(0, 400) }) + '\n'); } catch {}
    return out;
  }
  for (const a of answers) {
    const n = need[a.i];
    if (!n) continue;
    let val = a.a == null ? null : String(a.a).trim();
    // Guardrail: when the field had options, an answer that is not one of them
    // is unusable - snap it to an exact option or drop it. The model returning
    // a paraphrase of an option is the single most common failure here.
    // Canonicalize to an exact option string when we can - but do NOT null a
    // non-matching answer. The option list handed to the model is truncated
    // (a university picker has thousands), so "McMaster University" is a
    // perfectly good answer that simply is not in the visible sample. The
    // caller matches it against the real, untruncated list.
    if (val && n.q.options && n.q.options.length) {
      const exact = n.q.options.find(o => String(o).trim() === val);
      const ci = exact || n.q.options.find(o => String(o).trim().toLowerCase() === val.toLowerCase());
      const loose = ci || n.q.options.find(o => norm(o) && (norm(o) === norm(val) || norm(o).startsWith(norm(val)) || norm(val).startsWith(norm(o))));
      if (loose) val = String(loose);
    }
    // Only real answers are cached. Caching a null would freeze the failure:
    // an improved prompt or a newly-added fact could never change it, and the
    // very first test run poisoned every later run this way.
    if (val) cache[n.k] = val; else cache[nullKey(n.k, facts)] = null;
    out.set(norm(n.q.q), val);
    try { fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ats: ctx.ats, q: String(n.q.q).slice(0, 120), opts: (n.q.options || []).slice(0, 8), a: val, why: a.why }) + '\n'); } catch {}
  }
  saveCache();
  return out;
}
