---
name: jobapply
description: Use when the user wants to auto-apply to internships via their JobRight Premium account (phrases like "apply to jobs", "run the job agent", "jobapply"). Drives real Chrome over CDP, harvests jobs from JobRight's own recommend feed, uses the JobRight autofill extension plus in-script filling on ATS sites, infers missing answers from the answer bank, and submits.
---

# JobRight auto-apply

Working dir is **always** `/Users/liyu.xiao/.jobagent`. All scripts assume cwd is there.

**Node must be `~/.local/share/mise/shims/node`.** Homebrew node is broken
(`libsimdutf.34.dylib` missing). Never call plain `node`.

## Preflight (every run, and every time you resume after killing something)

1. **Chrome on CDP.** `bash ~/.jobagent/bin/chrome.sh` — idempotent; starts Chrome
   with `--remote-debugging-port=9222` on the dedicated profile if not already up.
   It must be the **real** Chrome (JobRight extension + logged-in session), never
   Playwright's bundled Chromium.
2. **If you just killed a script**, open one tab before reconnecting:
   `curl -s -X PUT "http://localhost:9222/json/new?about:blank" >/dev/null`
   Zero open tabs breaks Playwright's `connectOverCDP` handshake
   (`Browser.setDownloadBehavior: Browser context management is not supported`)
   even though `/json/version` still responds fine. See `references/gotchas.md`.
3. **Verify JobRight is logged in.** If not, tell the user to log in themselves —
   do not attempt to type credentials.
4. **Baseline the Applied counter** (see Reporting below) before starting. This is
   the **only** authoritative submission count; script logs over- and under-report.

## Standing policy

Fully automatic — apply to everything reachable, skip rather than stall, don't
stop to ask. Hard skips, in the order scripts check them:
- **Workday** → `skip-workday` (no form renders without an account)
- **Email/password login wall** → `skip-login`
- **"Create an account first" portals** → `skip-account` (`needsAccount()`)
- **Oracle CandidateExperience** → `skip-login`. APPLY NOW leads to
  `/apply/email`, which emails a 6-digit PIN and has no guest path. Its PIN
  screen has exactly 2 inputs (`primary-email` + honeypot), so it used to log
  as `too-sparse-refused` at 1/2 on ~16 jobs/run. It is a login wall.
- **Hosts in `ats_skip.txt`** → `skip-listed` (TikTok/ByteDance — the autofill
  link never lands on a real form for these; add more here if you find others)
- **A genuinely rendered, interactive captcha** → `skip-captcha-visible`,
  judged only *after* attempting to reveal the real form, never from a landing
  page. Rendered-size alone is NOT the test — see gotchas. Hosts in
  `ats_allow.txt` are hand-verified fillable and never captcha-skipped.

**Every other outcome is a bug until proven otherwise.** `too-sparse-refused`,
`submit-unconfirmed`, `no-form-found` on a job that clearly has a form — don't
accept these as "just how that ATS is." Root-cause them (see Debugging below).
Two whole sessions' worth of fixes (2026-09-13 and 2026-09-20) turned out to be
silent-failure bugs wearing a legitimate-skip costume — including two that were
reporting *successful* applications as failures, and one that was filling a
country field with "No". See `references/gotchas.md`.

Never guess an answer that isn't in the bank or derivable by the inference
rules; log it to `gaps.jsonl` and leave the job unsubmitted.

## The two apply paths, in order

1. **EASY APPLY first** (`apply3.mjs`) — in-platform, on JobRight's own domain,
   highest reliability. Submits directly when available; marks the job
   `offsite-deferred` when the job only offers APPLY WITH AUTOFILL.
2. **APPLY WITH AUTOFILL second** (`offsite3.mjs`) — takes the `offsite-deferred`
   pile from step 1 and works the actual ATS site (Lever, Ashby, Greenhouse,
   Paylocity, Eightfold, etc.). Lower reliability per job but covers everything
   EASY APPLY can't.

Do not chain these blindly — run EASY APPLY over the whole scoped queue first,
*then* build the offsite batch from what it marked `offsite-deferred`. Both
scripts read `QUEUE_FILE` (defaults to `ms_jobs.json`) and both dedupe against
their own ledger.

**Never run the two passes at the same time.** They share one Chrome, and
offsite3 opens a new ATS tab for nearly every job. Changing the active tab
dismisses the JobRight autofill modal that apply3 depends on, so apply3 jobs
fail intermittently at a LOW fill count (2/20 where the same job does 16/21
alone) and burn `MAX_ATTEMPTS` slots on records that look like real outcomes.
Proven 2026-09-22: three affected jobs all recovered on the same build with
offsite3 stopped. A changed `total` on the same job (41 vs 40) is the tell.
See `references/gotchas.md`.

**`ONLY=<id>,<id>` works in `offsite3.mjs` only — `apply3.mjs` ignores it.**
Passing `ONLY=` to apply3 silently re-runs the ENTIRE queue (800 jobs, hours).
To re-test specific EASY APPLY jobs, cut a small `QUEUE_FILE` instead. In
offsite3, `ONLY=` also bypasses the ledger/`MAX_ATTEMPTS` check, so it is the
right way to retry a fixed job without editing `offsite3.jsonl`.

## Drain the backlog before harvesting more (audit 2026-09-23)

Run `bash bin/status.sh` first and read its **backlog** section. On 2026-09-23
it showed:
- **1098 `offsite-deferred` jobs offsite3 had never attempted.** An
  `offsite_batch.json` of 495 had been built and never run. The limit on yield
  was the backlog, not the code. Drain it before harvesting a fresh feed.
- **670 `skip-external-redirect` + `no-apply-button` jobs that NEITHER pass
  handles.** apply3's comment says APPLY NOW "redirects to LinkedIn/
  ZipRecruiter", but nobody ever probed that. The samples (Activision, K2
  Space, AnaVation) are companies with direct ATS postings. This is the
  largest unverified assumption in the pipeline. **Probed and disproved the
  same day:** `applyLink` is usually the employer's own ATS. offsite3 now
  opens it directly, so these statuses go in the offsite batch (see the
  builder below). Expect many of them to hit Workday or a login wall. The
  gain is the Ashby/Lever/Greenhouse minority.
- **217 `too-sparse-refused` records written before the `sparse` diagnostic
  existed.** Many were probably fixed since (the Oracle reclassification, the
  loading race). They carry 1 attempt each, so they are still retryable.

Ledger records now carry `ts` and `run` (the run's start minute). To measure
one run, filter on `run`. Don't guess from record order.

`LIMIT` slices the queue **before** the ledger dedupe in both scripts. On a
queue whose head is already done, `LIMIT=20` processes nothing. Build the batch
excluding done ids, as the offsite builder does.

## Sourcing and scoping the queue

**Preferred source**: JobRight's own recommend feed, not the old intern-list.com
minisite grid.
```
cd ~/.jobagent && ROUNDS=200 ~/.local/share/mise/shims/node harvest_recommend.mjs
```
Writes `jr_jobs.json`. (`harvest_ms.mjs` → `ms_jobs.json` from
`jobright.ai/minisites-jobs/intern/us/<cat>` still works if you need the older
curated-intern subset instead — `CATS=swe,...` comma-separated.)

**Location-scope** whichever harvest you used before running anything expensive:
```js
const jobs = JSON.parse(fs.readFileSync('jr_jobs.json', 'utf8'));
const CITY = /,\s*CA\b|california|,\s*TX\b|texas|seattle|bellevue, wa|redmond, wa|,\s*NY\b|new york/i;
const matched = jobs.filter(j => CITY.test(j.txt || ''));
fs.writeFileSync('jr_jobs_target.json', JSON.stringify(matched));
```
This is inline scratch code, not a saved script — the exact city/state list
changes per request, so write it fresh each time rather than trusting a stale
filter file.

## Running EASY APPLY

```
cd ~/.jobagent && QUEUE_FILE=jr_jobs_target.json SUBMIT=1 ~/.local/share/mise/shims/node apply3.mjs > apply3.log 2>&1 &
```
- Omit `SUBMIT=1` for a dry run.
- `applied3.jsonl` is the ledger. `offsite-deferred` entries there, filtered to
  your current scope, are the input to the next step.

## Running APPLY WITH AUTOFILL

Build the offsite batch from what EASY APPLY deferred, then run:
```js
const applied = fs.readFileSync('applied3.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const target = new Set(JSON.parse(fs.readFileSync('jr_jobs_target.json','utf8')).map(j=>j.id));
const done = fs.existsSync('offsite3.jsonl') ? new Set(fs.readFileSync('offsite3.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l).id)) : new Set();
// skip-external-redirect / no-apply-button belong here too: offsite3 opens the
// job's applyLink directly, which is usually the employer's own ATS (2026-09-23).
const OFFSITE = /^(offsite-deferred|skip-external-redirect|no-apply-button)$/;
const deferred = applied.filter(r => OFFSITE.test(r.status) && target.has(r.id) && !done.has(r.id));
fs.writeFileSync('offsite_batch.json', JSON.stringify(deferred.map(r => ({ id: r.id, txt: r.title }))));
```
```
cd ~/.jobagent && QUEUE_FILE=offsite_batch.json LIMIT=20 SUBMIT=1 nohup ~/.local/share/mise/shims/node offsite3.mjs > offsite3.log 2>&1 &
```
- `LIMIT=n` caps a run — use a small number (5–10) after any code change, before
  trusting it on the full batch.
- Run in the background; a large batch is hours. Poll with a Monitor loop on
  `pgrep -f "offsite3.mjs"`, not a raw sleep.

## Debugging a bad outcome (do this, don't guess)

This is the loop that found and fixed six real bugs in one session — follow it
every time a job produces anything other than a clean `SUBMITTED` or a
legitimate hard skip:

0. **Read the record first.** `offsite3.jsonl` already carries `req`, `btns`,
   `navErrs` and `wiz` on a stalled job (see Env flags below). The ATS usually
   names the blocking field itself — Ashby and Paylocity both do. Do not open a
   browser until you have read what the last run already told you.
1. **Isolate the one job.** `ONLY=<jobId> QUEUE_FILE=<file-containing-it>` — no
   `SUBMIT=1` yet. Note `ONLY=` is offsite3-only; for apply3, cut a small
   `QUEUE_FILE`.
2. **Probe the real page directly**, not through the script, when the status is
   ambiguous (`too-sparse-refused`, `skip-captcha-visible`, `submit-unconfirmed`).
   Write a throwaway `_probe_*.mjs` that connects over CDP, navigates to the ATS
   URL, and inspects: is there really no form (check for iframes, cookie-banner
   dark overlays, an "Apply" button that needs clicking first)? Is the captcha
   actually rendered (size, `visibility`, `display`, `opacity`, viewport
   position — not just element existence)? Delete the probe file when done.
3. **If the isolated reasoning contradicts the live behavior** (this happened
   more than once), don't trust the reasoning — add a temporary
   `if (process.env.DEBUG_X) console.error(...)` at the exact decision point in
   the real script, gate it behind an env var, rerun with that var set, and read
   the actual runtime values. Remove the debug line once the fix is confirmed.
4. **Fix the narrowest thing that explains the evidence.** Re-run the same
   `ONLY=` job to confirm the fix closes the gap before touching anything else.
5. **Only then** widen to a `LIMIT=5`–`20` batch with `SUBMIT=1` to confirm the
   fix generalizes and check for regressions.
6. **Stop after two failed hypotheses on the same control.** Paylocity ate five
   consecutive selector/timing edits that each looked right and changed nothing.
   When that happens the next step is `DEBUG_COMBO=1` or a temporary
   `console.error` at the decision point — real runtime values, not a sixth guess.

Common root causes found this way, roughly in order of how often they recur:
absolute thresholds that don't check for actual progress, checks that run
before the thing they're gating on has had a chance to happen, silent
`.catch(() => {})` swallowing a real failure, and a control type (iframe,
custom combobox, JS-rendered radio) the code was never written to see at all.
Full writeups are in `references/gotchas.md`.

## Close the gap loop

After a pass, read `gaps.jsonl`. For each unresolved question that's genuinely
answerable and not on the `never_infer` list, add it to `learned.json` —
`{"<question substring>": "<answer>"}`. It's checked first, before any regex
rule, in both scripts' `infer()`. Then remove those job ids from the relevant
ledger and re-run just those.

**Read `references/never-answer.md` first.** Many gaps are *correct* — a
regulatory disclosure, a self-rated proficiency, a US-only `State` list against
an Ontario address, a document that does not exist on disk. That file lists
them with the reason, so the same questions do not get re-litigated (or worse,
answered) every session. It also carries the two rules for adding a learned
answer: check it against a REAL option list, and country-qualify anything about
entitlement or status (`LEARNED` is consulted before the WORK_AUTH rule, so a
broad key can assert "Yes" on US work authorization, where
`answers.json` says `work_auth: false`).

**Prune jobs whose every remaining gap is deliberate.** They can never close
and each one costs a full `JOB_TIMEOUT` slot on every pass. Select by outcome,
not by attempt count:

```js
// keep non-terminal jobs with real progress, drop the permanently blocked
const NEVER = [/which area is your (first|second|third) choice/i,
               /how familiar are you with/i, /proficiency with/i,
               /investment-related civil action/i, /u\.?s\.? person status|itar/i,
               /country country \*phone/i, /mathematics competitions/i,
               /research supplement|writing sample|portfolio|cover letter/i];
const gaps = (r.unresolved || []).map(u => ' ' + (u.q || '').replace(/\s+/g, ' '));
const dead = gaps.length > 0 && gaps.every(g => NEVER.some(re => re.test(g)));
```

Watch the selection criteria in any such builder: a `filled >= 10` filter looks
sensible and silently excludes exactly the modal-vanish jobs, because a
vanished modal reads as a LOW fill count (2/20 where the same job does 16/21).

## The resolver rewrite — SHADOW MODE ONLY, does not drive real fills

`formir.mjs` (pure DOM extraction), `resolve.mjs` + `resolve-patch.mjs` (pure
resolution given a form description and `answers.json`), and `answers.json`
(the new-schema fact store) are wired into `offsite3.mjs` but **only observe**:
they snapshot the pre-fill form to `fixtures/`, compute what they'd fill, and
log the comparison against what the live `infer()`/`BANK` path actually did to
`shadow.jsonl`. The live fill is still driven entirely by `offsite3.mjs`'s own
`BANK`/`bankValue()`/`infer()` — **if you add or fix a fact, it has to go in
BOTH `answers.json` (for the shadow resolver) AND `offsite3.mjs`'s own `BANK`
object (for the actual fill)**, or the live path won't see it. This has now bit
us TWICE: address fields existed in `answers.json` for a full session before
anyone noticed `BANK` never got them, and then `gpa` did exactly the same thing
(Ashby names the blocking field in its own validation text — "Missing entry for
required field: What is your GPA?" — on a form we had the answer for all along).

Set `SHADOW=0` to disable the observation pass entirely (e.g. for speed on a
huge batch once you don't need more comparison data).

Cutover plan (not yet executed): once `node resolve.mjs fixtures/ answers.json`
shows resolve.mjs beating `infer()`'s rate on ~30+ real fixtures, delete
`infer()` and the regex rule list, keep `learned.json` (the new cache keys on
`section+label+control+options`, not question text alone).

## Custom comboboxes (live path — built, and load-bearing)

**Custom comboboxes are now handled** by `fillComboboxes()` (gate: `COMBO=0`
disables). It covers `[role=combobox]`, `input[aria-autocomplete=list]` and
`[class*=select__control]`, including `div[role=combobox]` widgets with no
native `<select>`. Three things in it are load-bearing — see gotchas:
- Options are read from the **last visible `[role=listbox]`**, not page-wide, and
  `pressEsc` runs before opening the next box. The old page-wide query let a
  dropdown left open earlier contribute its options to the next field, and a
  Paylocity *country* field was offered `["Yes","No","Yes*"]` and nearly answered
  `"No"`. This was writing wrong data, not just failing.
- The label climbs ancestors for text >=15 chars that isn't all dashes. A
  `div[role=combobox]`'s nearest non-empty text is often its own `--`
  placeholder, so `infer()` was being asked to answer the string `"--"`.
- A typeahead that renders no options until you type is seeded from
  `bankValue(label)`; if that fails it logs an `unresolved` gap rather than
  escaping silently.

## Env flags and per-record diagnostics

Flags: `SUBMIT=1` (omit for dry run) · `LIMIT=n` · `ONLY=` (offsite3 only) ·
`QUEUE_FILE=` · `MAX_ATTEMPTS=` (default 3) · `MAX_TIMEOUTS=` (offsite3, default 2: `err:timeout` doesn't use an attempt, so without this cap a job that always times out costs a full `JOB_TIMEOUT` every pass) · `JOB_TIMEOUT=` ms · `SHADOW=0` ·
`COMBO=0` · `LLM=0` · `DEBUG_COMBO=1` (logs each combobox's
id/label/options/choice — this is how the option-leak bug was found) ·
`DEBUG_TXT=1` (apply3: logs each text-field fill as `{q, v, found}`) ·
`REPEAT=1` (**leave OFF**, see below).
Added 2026-09-24 (offsite3): `SKIP_SINCE=<ISO ts>` (a job attempted since then
counts as done for this pass; use it on every mid-run restart, or each restart
re-fails the same heavy jobs at the shard head) · `JOB_MAX=` (ms, default
600000: a wizard that is genuinely advancing may extend past `JOB_TIMEOUT` up
to this) · `DEBUG_TIME=1` (per-stage `fillAll` timing and phase timestamps -
how the 50s banner step and the 207s Palantir text pass were found) ·
`PAYLOCITY=1` (un-park Paylocity).

**Parallel workers:** `bash bin/restart.sh [N]` starts N shard workers under
`bin/watchdog.sh`, which restarts any that die or go silent for `STALL`
seconds. Shard files are `shard0..N-1.json`. Restart the automation Chrome
every few hours: it reached 19.7 GB RSS after ~5h and slowed every page.

**`JOB_TIMEOUT` defaults are too low for the heavy families.** Use
`JOB_TIMEOUT=600000` on offsite3 (default 360000) and `720000` on apply3
(default 120000) whenever the batch includes Phenom, Paylocity, UltiPro or any
40+ field form. Raising it from 360000 to 600000 turned a job that had timed
out at `-/-` on two consecutive passes into a real `2/91` record. `err:*` does
NOT consume a `MAX_ATTEMPTS` slot, so a timeout is not a lost attempt — but it
is a lost *outcome*, and 10 minutes of wall clock with nothing to show.

`offsite3.jsonl` records carry, on a stalled job:
- `req` — required-and-empty field labels
- `btns` — visible controls as `text#id`, which is how Paylocity was identified
  as a wizard rather than a selector miss
- `navErrs` — the ATS's **own** validation text after a refused Next click
- `wiz` — the wizard steps actually visited (`adv-no-next`, `adv-stuck0`, …)
- `phase` + `elapsed` — on `err:*`, which stage consumed the budget
  (`open` / `fill` / `wizard:N` / `finalscan` / `submitted`) and how long.
  Both instrumented timeouts so far read `phase:"fill"`, which exonerated the
  wizard walk that looked guilty.
- `sparse` — `{total, filled, grew}` on `too-sparse-refused`. `grew:false`
  means the page was genuinely done rendering, not mid-render.
- `capWhy` — on `skip-captcha-visible`, WHICH iframe/element tripped it and its
  rendered box. An `api2/anchor` iframe at ~256x60 is a real v2 checkbox.
- `scanErr` + `scanUrl` — on `scan-failed`, a `readyState` probe, since
  `scan()` ends in `.catch(() => null)` and otherwise discards the reason.
- `selErr` + `wanted` — on an unresolved select, the error from a
  `selectOption` that failed even though an answer was resolved.

`applied3.jsonl` records carry:
- `phase` — `loaded` / `files` / `select:N` / `text:N` / `submit`. Survives a
  `JOB_TIMEOUT` abort, which discards `unresolved`/`reqGaps`.
- `sparse` — `{modals, inputs, head}`. `modals:0` means the JobRight modal
  VANISHED, which is a different failure from a short form.
- `txtTrail` — per text-field: `N:ok` or `N:gone-before-scan` /
  `gone-after-click` / `gone-after-type` / `gone-after-tab`, i.e. exactly which
  step lost the modal.
- `btns` / `btnsPage` / `submitLike` — modal-scoped clickables, then page-wide
  as `text#id@container`, then any LEAF element whose own text is "Submit".
  `btnsPage` also captures JobRight's nav, so it yields a free **Applied N**
  counter read with no tab navigation — useful while offsite3 is live.
- `nopts` — the FULL option count seen, next to the 30-option sample. Without
  it you cannot tell a finished read from the record's own truncation.
- `afterSubmit` — `{modals, modalHead, errs, url}` on `submit-unconfirmed`.

Read these before theorising. Every fix in the 2026-09-20 session came from
them, and on 2026-09-22 a diagnostic disproved my own leading hypothesis three
separate times — the loading race, the Netflix captcha, and the modal-vanish.
**Add the diagnostic before attempting the fix.**

**Do not set `REPEAT=1` casually.** `expandRepeaters()` clicks "Add Work
History"/"Add Education", but `fillAll` runs once per wizard step, so it built
SIX work-history rows on one Paylocity form. Each row adds a required
Country/State/**County** block and `county` is `null` + "Not known. Gap it." in
`answers.json` — so every extra row made the form strictly *less* submittable.

## Where the yield actually is (2026-09-21)

Measure against **reachable**, not the raw queue: reachable = total − Workday −
`skip-login` − `skip-account` − `skip-listed`. On a 410-job offsite batch that
was 410 − 235 = ~175 reachable.

- EASY APPLY: **~71%** of jobs that actually offer it (55 submitted + 7
  already-applied of 87 unique). Divide by the whole queue and you get a
  meaningless ~9% — most of the queue never offers EASY APPLY at all.
- APPLY WITH AUTOFILL: **~12%** of reachable. Target is 20%+.

The remaining gap is concentrated in whole ATS families, each needing its own
work — not one shared bug:
- **UltiPro (~14/run)** — top document serves 0 inputs and no apply control, and
  it is NOT a timing issue (body stable at 6KB after 40s). Needs frame-level work.
- **ADP (~10/run)** — two "Apply" elements; `.first()` picks one whose click
  times out. `.filter({visible:true})` was added and did not fix it alone.
- **SmartRecruiters (~5/run)** — CTA is "I'm interested" (added to the reveal
  list); still returns `no-form-found`, so something downstream is also wrong.
- **Paylocity (~9/run)** — fills to ~45/80 with every reported error cleared, but
  `Next Step` (`id=btn-submit`, **not** `type=submit`) neither advances nor
  errors when the form is filled, though it *does* error on a bare page. Ends
  `adv-stuck0`. Needs live observation of the click, not another selector edit.
- **Phenom (ledfaststart / excellusbcbs / freddiemac, 2026-09-22)** — the
  advance control reads **"Continue to Application"**, which the anchored
  next/continue list never matched, so the whole family died at `adv-no-next`.
  Now recognised. What that exposed is the real problem: one such form scans
  **91 fields and fills 2**. Fill coverage, not the wizard, is the prize here.
  These forms also consume the entire `JOB_TIMEOUT` inside `fillAll`.

### EASY APPLY, measured 2026-09-22

- `too-sparse-refused 0/0` was never a sparse form — it was a race against
  JobRight's own "Loading the application form" state. Fixing it turned six
  0/0 refusals into forms filled 20–38 fields deep in a single pass.
- `no-submit-btn` is **not** a locator bug: 36 of 36 such records carry ≥1
  unresolved gap and **zero** carry none, while 130 of 150 `SUBMITTED` carry
  none. JobRight hides Submit until the form is complete. Close the gap; do
  not widen the selector.
- Ant dropdowns are **virtualized** (~9 option nodes in the DOM), so every
  long select — states, countries, year lists — was unanswerable past the
  ninth option until the list holder is scrolled.

The three submissions that pass produced all came from closing a *specific*
named gap (a location select, a metro-area select, a military-branch field),
not from any change to the submit path.

## Probing and monitoring pitfalls

- Throwaway probes must `import { chromium } from 'playwright-core'` (NOT
  `'playwright'`) and run **from `~/.jobagent`** — that's where `node_modules`
  lives. Give every `frame.evaluate()` a `Promise.race` timeout; a cross-origin
  or detached frame can hang forever and wedge the probe.
- **`pgrep -f "apply3.mjs"` matches the monitoring shell's own command line**, so
  an `until ! pgrep -f ...` loop reports "still running" forever after the script
  has exited. Check for the `processed=` line in the log instead.
- Close stale tabs between runs (`/json/list` → `/json/close/<id>`). A pile of
  leftover tabs preceded two browser-connection deaths.

## Reporting results

```
bash ~/.jobagent/bin/status.sh
```
Runs `bin/funnel.mjs`: latest status **per job id** for each ledger, plus a
backlog section. The old version counted raw ledger lines, so a job retried 3x
counted 3x, and it never showed work that had not been attempted yet. Then **confirm against JobRight's Applied counter** (open
`jobright.ai/jobs/recommend`, read "Applied N" from the nav) and report the
delta, not any script's `submitted=` line. If they disagree, the counter wins.

## Files

| file | role |
|---|---|
| `answers.yaml` | legacy answer bank (yaml) — superseded by `answers.json`, kept for reference |
| `answers.json` | current fact store, feeds the shadow resolver |
| `learned.json` | subagent/manually-resolved answers, highest priority in `infer()` |
| `harvest_recommend.mjs` | harvests `jobright.ai/jobs/recommend` → `jr_jobs.json` (preferred source) |
| `harvest_ms.mjs` | harvests the old minisite grid → `ms_jobs.json` |
| `jr_jobs.json`, `jr_jobs_target.json` | full / location-scoped queue from the recommend feed |
| `ms_jobs.json`, `ms_jobs_target.json` | full / location-scoped queue from the minisite grid |
| `apply3.mjs` | EASY APPLY pass — run this **first** |
| `applied3.jsonl` | ledger for the EASY APPLY pass |
| `offsite3.mjs` | APPLY WITH AUTOFILL pass — run this **second**, on what EASY APPLY deferred |
| `offsite3.jsonl` | ledger for the autofill pass |
| `ats_allow.txt` | ATS hosts hand-verified fillable; captcha check bypassed |
| `ats_skip.txt` | hosts/titles to hard-skip — autofill never lands on a real form |
| `gaps.jsonl` | unresolved questions awaiting inference |
| `formir.mjs`, `resolve.mjs`, `resolve-patch.mjs` | shadow-mode resolver rewrite — see above |
| `references/gotchas.md` | every bug that cost real yield — **read before changing a script** |
| `references/never-answer.md` | questions to leave gapped, with the reason for each |
| `fixtures/`, `shadow.jsonl` | shadow-mode output — form snapshots and infer-vs-resolve comparisons |
| `resume.pdf`, `transcript.pdf` | uploads |
| `archive_v1/` | superseded architectures — do not resurrect |

## Measuring before reacting

Two mistakes of this kind were caught on 2026-09-22, both one step from an
unnecessary restart:

- A retry-first queue's HEAD is enriched with previously-failed jobs by
  construction, so a rate measured there is not the run's rate. Three timeouts
  in the first four jobs looked alarming; across the whole 867-job queue only
  8 jobs (3%) had any prior timeout, and 0 of the 585 fresh ones did.
- `gaps.jsonl` and both ledgers are **append-only**. A "last N records" sample
  mixes in pre-restart history. Scope to the current run's job ids, or count
  per-id, before concluding anything about a rate.

Restarting a pass to pick up a fix is cheap in the first ~10 jobs and
expensive later. Decide early, then commit — and prefer letting a long pass
finish over re-tuning it mid-flight. Nine restarts in one session once left
apply3 having never run more than 15 jobs; once left alone it completed 536.

## Before changing any script

Read `references/gotchas.md`. Several "obvious simplifications" in these
scripts are load-bearing — it records every bug that cost real yield, most of
them the kind that look like a correct skip until you actually check.
