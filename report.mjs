// Write results.html: every job's latest outcome from both passes, READY and
// SUBMITTED first, with a link to the job and the questions left unanswered.
//   node report.mjs     (then open results.html)
import fs from 'fs';
const lines = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const latest = new Map();
for (const [pass, f] of [['JobRight EASY APPLY', 'applied3.jsonl'], ['Company website', 'offsite3.jsonl']])
  for (const r of lines(f)) {
    // Pass 1 hands these to pass 2; the pass-2 record is the one that matters.
    if (pass === 'JobRight EASY APPLY' && /^(offsite-deferred|skip-external-redirect|no-apply-button)$/.test(r.status) && latest.has(r.id)) continue;
    latest.set(r.id, { ...r, pass });
  }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const rows = [...latest.values()];
const EXPLAIN = {
  SUBMITTED: 'Application sent', 'ALREADY-APPLIED': 'You had already applied',
  READY: 'Filled in the practice run; will be submitted by Apply for real',
  'offsite-deferred': 'Waiting for the company-website pass', 'skip-external-redirect': 'Waiting for the company-website pass',
  'skip-workday': 'Workday site: needs an account, skipped', 'skip-login': 'Needs a login, skipped', 'skip-account': 'Needs an account, skipped',
  'skip-captcha-visible': 'Human-check puzzle (captcha), skipped', 'skip-listed': 'Site on the skip list',
  'no-ats-tab': 'Company page did not open', 'too-sparse-refused': 'Form did not load properly',
};
const order = s => ({ SUBMITTED: 0, READY: 1 }[s] ?? 2);
rows.sort((a, b) => order(a.status) - order(b.status) || String(a.status).localeCompare(String(b.status)));
const counts = {}; for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
const tr = r => `<tr class="${r.status === 'READY' ? 'ready' : r.status === 'SUBMITTED' ? 'sub' : ''}">
<td><a href="https://jobright.ai/jobs/info/${esc(r.id)}" target="_blank">${esc(r.title)}</a></td>
<td><b>${esc(r.status)}</b><br><small>${esc(EXPLAIN[r.status] || '')}</small></td>
<td>${esc(r.pass)}</td><td>${r.filled != null ? `${r.filled}/${r.total}` : ''}</td>
<td><small>${(r.unresolved || []).map(u => esc(u.q)).join('<br>')}</small></td>
<td><small>${esc(String(r.ts || '').slice(0, 16).replace('T', ' '))}</small></td></tr>`;
fs.writeFileSync('results.html', `<!doctype html><meta charset="utf-8"><title>Job agent results</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;background:#fff;color:#222}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}tr.ready{background:#fff8d6}tr.sub{background:#dcf5dc}
a{color:#0645ad}.c span{display:inline-block;margin:0 12px 6px 0}</style>
<h1>Job agent results</h1><p class="c">${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span><b>${v}</b> ${esc(k)}</span>`).join('')}</p>
<p>Fill counts are fields filled / fields on the form. "Unanswered" lists questions the agent had no answer for.</p>
<table><tr><th>Job</th><th>Result</th><th>Where</th><th>Filled</th><th>Unanswered</th><th>When (UTC)</th></tr>${rows.map(tr).join('')}</table>`);
console.log(`results.html written: ${rows.length} jobs (${counts.READY || 0} READY, ${counts.SUBMITTED || 0} SUBMITTED)`);
