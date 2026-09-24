// Next EASY APPLY queue: non-terminal jobs with real progress (>=10 filled),
// EXCLUDING any whose every remaining gap is on the deliberate do-not-answer
// list. Those can never close and just burn 12-minute job slots.
const fs = require('fs');
const D = __dirname + '/';
const TERMINAL = /^(SUBMITTED|ALREADY-APPLIED|skip-listed|offsite-deferred)$/;
const WANT = /^(no-submit-btn|too-sparse-refused|needs-inference|submit-unconfirmed)$/;
// Documented in this file's "Deliberately NOT answered" sections.
const NEVER = [
  /which area is your (first|second|third) choice/i,     // Datadog domain pick
  /how familiar are you with/i,                          // self-rated familiarity
  /proficiency with|proficiency (level )?(in|with)/i,    // never_agreeable
  /investment-related civil action|pending.*civil action/i, // FINRA disclosure
  /u\.?s\.? person status|itar/i,
  /country country \*phone/i,                            // mangled label
  /mathematics competitions/i,                           // factual claim, no bank fact
  /research supplement|writing sample|portfolio|cover letter/i, // document we lack
  /start month\/year of university/i,                    // needs a new bank fact
];
const recs = fs.readFileSync(D + 'applied3.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const last = new Map();
for (const r of recs) last.set(r.id, r);
const q = JSON.parse(fs.readFileSync(D + 'run22_queue.json', 'utf8'));
const keep = [], blocked = [];
for (const j of q) {
  const r = last.get(j.id);
  if (!r || TERMINAL.test(r.status) || !WANT.test(r.status) || (r.filled || 0) < 10) continue;
  const gaps = (r.unresolved || []).map(u => ' ' + (u.q || '').replace(/\s+/g, ' '));
  const allDead = gaps.length > 0 && gaps.every(g => NEVER.some(re => re.test(g)));
  (allDead ? blocked : keep).push([j, r]);
}
fs.writeFileSync(D + 'apply3_sb.json', JSON.stringify(keep.map(([j]) => j)));
console.log('queue', keep.length, '| permanently blocked, excluded:', blocked.length);
for (const [, r] of blocked) console.log('  x', r.filled + '/' + r.total, (r.title || '').slice(0, 44));
