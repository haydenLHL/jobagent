# jobapply gotchas

Every item here was a real bug that cost applications. Do not "simplify" them away.

## Playwright's 30s default timeout was the biggest time sink on big forms (2026-09-24)

`DEBUG_TIME=1` `[slowfield]` lines showed text fields taking exactly ~30000ms
with no label: `locator.evaluate()` on a stale nth-locator (from `.all()`,
after the form re-rendered following a fill) waits the full default timeout
for an element that no longer exists. 7 of those = 210s, matching Palantir's
207s first text pass. offsite3 now sets `c.setDefaultTimeout(6000)`
(`DEFAULT_TIMEOUT=` env) on connect and on reconnect. Every intentional wait
passes its own timeout. Before this, the same investigation wrongly blamed
the radio matrix. **Measure per field before optimising a pass.**

## Typeahead "recommit" was scrambling phone country codes (2026-09-24) - READ THIS

The recommit path (re-select a combobox's displayed value so the ATS commits
it) fell back to the FIRST option when no suggestion matched. Rippling's
phone-country picker is a combobox labeled "Search" showing "+1 US"; its list
does not filter on that text, so every sweep clicked the first visible option:
+1 US -> +998 UZ -> +598 UY -> +39 VA. The phone became invalid and the form
silently refused to submit (type=submit click, no errors, no navigation).
Found with DEBUG_TA. Fix: when re-committing the field's own shown value, click
only a MATCHING suggestion; otherwise Escape and leave it. The Rippling job
then submitted ("successfully applied"). Any ATS with a searchable phone-code
picker was exposed to this.

## ARIA radios: click the role=radio element, not the input (2026-09-24)

Rippling renders `<div role=radio aria-checked>` around a zero-size input
with no `<label>`. `.check()` on the input -> "not visible"; the label
fallback finds nothing; clicking the `role=radio` ancestor works. fillRadios
now tries that, and its verification also accepts `aria-checked="true"`. The
required SMS-consent radio was the second Rippling blocker.

## Dialog race between parallel workers (2026-09-24)

Every connected worker dismisses every native dialog in the shared context;
the losers' "No dialog is showing" rejections hit the process-level handler,
which called exit(1) - killing a worker mid-submit. Now ignored as benign.

## Ashby confirmation can arrive after 30s: `submit-unconfirmed` may be a real submission (2026-09-24)

Two Ashby jobs (opengov, base-power) came back `submit-unconfirmed` twice
each, with 0 errors and the form still visible. A third run of base-power,
with new `diag.chal` / `diag.sbState` / `diag.tail` diagnostics, was
confirmed by `late-diag`: "We've received your application" loaded after the
window closed. The earlier attempts were probably real, so base-power may hold
duplicate applications. OpenGov was parked as terminal `skip-probable-dup`.
Fixes: confirmation loop 10x3s -> 14x3s, and late-diag also reads the page
TAIL, but only with strict phrases ("received your application", "thanks for
applying"), not bare "thank you", which can appear in a form's footer. **Treat
repeated 0-error `submit-unconfirmed` on one job as a probable success, not
something to retry.**

## Rippling: random page locale, generic upload captions, false `after:0` (2026-09-24)

- `ats.rippling.com` serves a random locale per visit (`de-DE` once, `en-AU`
  next) whatever Accept-Language says. A German page has no "Apply" text, so
  the reveal failed with `too-sparse-refused 1/1`. Fixed: non-English Rippling
  URLs are rewritten to `/en-US/`, and Bewerben/Postuler/Aplicar/Candidatar are
  in the reveal list.
- Upload inputs are captioned "Drop or select (.doc / .docx / .pdf)"; the
  field name ("Résumé*", "Cover letter") sits in a wrapper. The offsite3 upload
  allowlist (ported from apply3 the same night) climbs to that wrapper when
  the caption is generic.
- After a successful upload `input.files.length` is 0 while the widget reads
  "resume.pdf uploaded successfully". The dropzone clears the input, so
  `files[].after:0` is NOT proof of failure here.

## Paylocity is parked, not skipped forever (2026-09-24)

It was 8 of 11 `err:timeout`s in one run, a full JOB_TIMEOUT each, and has
never submitted. offsite3 now records `skip-paylocity-unsolved` (terminal) at
landing. `PAYLOCITY=1` disables the park. After solving the wizard, re-queue
by selecting that status.

## The LLM fallback silently hung on every call when launched from Claude Code (2026-09-24)

`llm.jsonl` showed 178 of the last 200 calls as `{"err":"parse","raw":"null"}`.
The child `claude -p` inherited the parent Claude Code session's
`ANTHROPIC_API_KEY` (plus `CLAUDE_CODE_*`) and hung until `LLM_TIMEOUT_MS`
(120s). So every job with a gap lost 2 minutes and got nothing back, which
alone explained a large share of 3-minute `err:timeout`s. Without that key, the
same call answers in ~2s via the claude.ai login. `llm.mjs` now strips both
from the child env. **Check `tail llm.jsonl` at the start of any run:** a run
of `raw:"null"` means the LLM is down, not that the questions are hard.
Separately: in the smoke test the model answered "No" to "Will your internship
be a mandatory part of your study program?", which no fact supports. Spot-check
`llm.jsonl` answers against `answers.json` occasionally.

## `/ext\b/` nulled every label containing "text", "context" or "next" (2026-09-23)

bankValue's phone-extension guard was `/ext(ension)?\b/`, unanchored on the
left. It matched "conTEXT", "TEXT" and "nEXT" and returned null before any
real rule ran. 71 past gaps hit it, including Palantir's required "Insert other
preferred location(s) and/or further context…", which already had a locPref
answer. The fix is `\bext(ension)?\b`. The bug had also been hiding a second
one: "May we send you text messages…" would now fall through to `/phone/` and
get the phone number typed in as the answer. An explicit SMS/consent guard now
comes before the phone rule. **Lesson:** a guard that returns null can be
load-bearing by accident. When you narrow one, re-test labels it used to catch.

## Lever: two silent submit-blockers (2026-09-23; location verified live, resume awaits a real submit)

Found by aggregating `diag.errs`/`diag.blanks` across all stalled offsite
records, not by probing:
- **"Please select a location from the dropdown menu and try again."** (9
  Lever jobs.) `#location-input` has no ARIA, so it was not treated as a combo:
  the full "Toronto, ON, Canada" was typed (no suggestions come back) and the
  suggestion rows (`.dropdown-results .dropdown-location`, plain divs) matched
  none of the generic option selectors. Fixed: that id counts as a combo
  (short query plus recommit), and the Lever class is in `OPT`.
- **"Resume/CV ✱ ATTACH RESUME/CV" still blank at submit, with `files=null`.**
  (8 jobs.) `fillFiles()` skipped any input whose `files.length > 0`. The
  extension sets that on Lever without the widget registering the file.
  Fixed: `n > 0` is trusted only if the wrapper isn't still showing an
  attach/upload prompt with no filename.

The first location fix (selector plus combo flag) changed nothing
(`optCount=0`). A live probe showed why: `fill()` sends no key events, and
Lever searches on keystrokes only. fill gave 0 suggestions and "No location
found"; `pressSequentially` gave 4. The fix is to retype when a combo shows no
suggestions, then prefer the suggestion that also contains the value's second
token ("Toronto, ON, CAN", not "Toronto, OH, USA"). Verified on drivetrain and
oddin: the location is committed with 0 unresolved. The resume fix can only be
confirmed by a real submit.

## APPLY NOW: the applyLink is usually the employer's ATS (2026-09-23)

apply3 wrote 529 jobs off as `skip-external-redirect` ("LinkedIn/ZipRecruiter
relay"), and nothing ever queued them for offsite3. Clicking APPLY NOW in
offsite3 ended `no-ats-tab` on 35 of 48 attempts. A probe of `__NEXT_DATA__`
showed `applyLink` pointing at the employer's own ATS in most cases. offsite3
now opens `applyLink` directly when there is no autofill button
(`via:"applylink"`). Relay hosts are in `ats_skip.txt`. First 7 through it: an
Ashby form READY at 14/29 with 0 gaps, 2 SuccessFactors `skip-login`, 2
Workday, 1 LinkedIn `skip-listed`, and Mercedes `no-form-found` behind a German
Usercentrics banner ("Akzeptieren"), which `dismissBanners` doesn't match yet.


## False SUBMITTED: multi-step wizards and career-portal search pages (2026-09-17) — READ THIS FIRST

The user caught this by cross-checking against actual confirmation emails: **the ledger
said SUBMITTED for jobs that were never actually applied to.** This is worse than a
missed application - it's a false claim of success, and it fed JobRight's own "Yes, I
applied" click too (JobRight's Applied count/list will show these as applied; there is
no easy way to un-click that from our side, so treat JobRight's tracker as
overstating reality by however many of these slipped through). Audit found 8 of 40
SUBMITTED entries in one session were false positives - all traced to the SAME root
cause.

**Root cause**: the final submit-button selector's fallback,
`button[type=submit]:visible, input[type=submit]:visible`, fires whenever no button
matches `/submit|apply|send application/i` by text. That fallback has no concept of
"is this actually the terminal action" - it grabbed:
1. **A multi-step wizard's "Next" button** (WEX, `id="next"`, genuinely `type=submit`
   since the site POSTs each step). WEX's application is six steps ("My information",
   "My experience", "Application questions", "Voluntary disclosures", "Self Identify",
   "Review"); we filled step 1 (12 of 14 fields - 2 short), clicked what we thought was
   Submit, and the URL changed step=1 -> step=2. The confirmation check accepts either
   matching text OR `tab.url() !== url0` - a step transition satisfies the URL-change
   condition just as well as a real completion does, so this reported SUBMITTED after
   1 of 6 steps.
2. **A "Search Jobs" button on a corporate career-portal landing page**
   (careers.fcsamerica.com, careers.westinghousenuclear.com, jobs.lincolnelectric.com).
   These land on a page with enough real inputs (5-16) to pass the `filled < 3` /
   `total < 5` reveal-gate and the `too-sparse-refused` floor, but the "form" is the
   site's own job-search widget, not an application. `type=submit` on a search button
   is completely ordinary HTML, so the fallback took it.

**Why the wizard-walking loop didn't already handle case 1**: unclear/not fully
resolved - the loop's own Next/Continue-button locator should have caught it before
ever reaching the fallback logic below. Multi-step wizard support is explicitly
**not built yet** (see SKILL.md's resolver-rewrite section for the parallel
custom-combobox gap) - don't assume the existing wizard loop is reliable.

**Fix applied**: a denylist,
`/^(next|continue|save\s*(and|&)\s*continue|back|previous|search\s*jobs?|search)$/i`,
checked against the selected button's exact visible text right before the click. Any
match -> `skip-multistep-wizard`, no click, no false success. This is a floor, not a
full fix: it stops the false-positive class, it does not make multi-step wizards or
career-portal search pages actually applyable. That's future work.

**A "Send" button (huaweicanada.recruitee.com, Recruitee ATS) was NOT flagged** -
Recruitee's real submit button is conventionally labeled "Send", and that entry had
5/5 fields filled. Don't add "Send" to the denylist without a specific reason; it is a
legitimate submit label on at least that ATS.

**Verification method that caught this**: don't trust the ledger or the JobRight
Applied counter alone. Revisit the exact ATS URL live and check the actual page state/
step. Re-attempting a submission and watching for a server-side duplicate rejection is
a stronger signal than a client-side "already applied" banner (many ATSs, Ashby
included, render the same blank form on every visit regardless of prior submission -
absence of a banner proves nothing either way).

## The reveal/reachability family (2026-09-13) — READ THIS SECOND (after the 09-12 one below)

Six more bugs, found by the same pattern as 09-12: a job reported a plausible skip or
partial fill, and every one turned out to be fixable. The common thread this round was
the "reveal" step — clicking through from a landing/description page to the real
application — silently failing in a new way each time.

1. **A cookie-consent overlay blocked the Apply-button click** (OneTrust,
   `#onetrust-accept-btn-handler`, "I Understand"). The click timed out (Playwright
   correctly refuses to click a covered element), so the reveal loop never got past the
   landing page. `dismissBanners()` already existed but only ran inside `fillAll()`,
   *after* the reveal attempt - too late. Call it before the reveal loop too.

2. **Captcha was judged on the landing page, before ever trying to reach the real
   form.** A widget unrelated to the actual application (general site captcha, search
   protection) killed jobs that would have been fine once revealed. Move the captcha
   gate to run *after* the reveal attempt, against wherever you actually land - not the
   first page you saw. (On at least one site the real form genuinely does have its own
   captcha too - moving the gate doesn't guarantee rescue, it just judges the right
   thing.)

3. **The reveal loop's success check was an absolute threshold (`total >= 5`), not
   "did this click actually do anything."** A landing page can already have >=5 stray
   inputs (a search box, filters). A hidden/unstable element matching an *earlier*
   selector (`button:has-text("Apply")` matching a decorative or off-screen node) can
   time out on click and the loop would still read the unchanged baseline as "success,"
   and never try the later, correct selector (`a:has-text("Apply")`). Capture the
   pre-click baseline ONCE, before the selector loop, and require **genuine growth past
   it**, not just an absolute floor:
   ```js
   const baseTotal = s?.total || 0;
   const revealed = st => st && st.total >= 5 && st.total > baseTotal;
   ```

4. **Radio clicks computed the right answer and then silently failed to register** on
   custom-styled widgets where the native `<input>` has `id=""` and is likely
   zero-size/hidden with a sibling doing the visible rendering (Paylocity and similar).
   `.check({force:true})` did not throw, but also did not take - `if (!done) unresolved
   .push(...)` fired even though `infer()` had already resolved the field correctly.
   This is EASY TO MISS: the field looks unresolved by `choice`, when actually `choice`
   was fine and the *click* failed. Fallback chain that fixed it: check the input →
   click its `closest('label')` (xpath ancestor) → trusted `.click({force:true})`
   directly on the input as a last resort.

5. **A text field can only be filled once per pass, but some fields only become
   fillable after a LATER step in the same pass resolves.** `fillAll()` ran
   `fillText()` once, then `fillSelects()`/`fillRadios()`. City/Zip fields that hydrate
   or unlock only after a Country/State selection never got a second chance on a
   single-page form with no wizard "Next" button. Fix: call `fillText()` again after
   selects/radios. It's already idempotent (skips anything with a value), so a second
   pass is free.

6. **The shadow-mode resolver rewrite (`answers.json`) and the LIVE fill path
   (`offsite3.mjs`'s own `BANK`/`bankValue()`) are two separate fact stores that do not
   share data.** Address fields were added to `answers.json` and assumed to be "in the
   bank" - they gapped every time anyway because `BANK` (what `fillText()` actually
   reads) never got them. Any new fact goes in BOTH places until the cutover to
   `resolve.mjs` actually happens (see SKILL.md).

### Also found, not yet fixed: custom comboboxes are an unhandled control type
React-Select-style country/state pickers render no native `<select>`, no native radio -
options don't exist in the DOM until the widget is opened. `fillSelects()` (queries
`select:visible`) and `fillRadios()` (queries `input[type=radio]`) both see nothing.
`formir.mjs` already anticipates this (`options: 'deferred'` for `[role=combobox]`) but
the live path has no equivalent. Confirmed present on at least one Paylocity address
block; likely on Workday and other React-based ATS forms too.

### The debugging method that found all six
Every one of these was invisible to static reading of the code - each individually
"looks fine." What worked, every time:
1. Isolate to one job: `ONLY=<id> QUEUE_FILE=<file>`, no `SUBMIT=1`.
2. Write a throwaway `_probe_*.mjs` connecting over CDP, navigate to the exact ATS URL,
   and check the SPECIFIC thing you suspect (is the button covered by an overlay? is
   there really an iframe? what does `elementFromPoint` say is on top?). Delete it after.
3. **If the isolated probe contradicts the live run's outcome, do not trust the
   isolated probe.** This happened repeatedly: `infer()` tested alone in a sandboxed
   `new Function(...)` returned the correct answer every time, yet the live run still
   gapped. The bug was never in `infer()` - it was in whether the *click* that should
   follow a correct answer actually registered. Add a temporary
   `if (process.env.DEBUG_X) console.error(...)` at the exact real decision point, gate
   behind an env var, rerun, read the real values, remove the line once fixed.
4. Fix the narrowest thing the evidence supports. Re-run the SAME single job to confirm
   before widening to a batch.

## The answer-resolution family (2026-09-22) — nine bugs, all in how an answer is LOOKED UP

Every one of these had the answer already sitting in `answers.json`/`BANK`/
`learned.json`. Nothing was missing from the fact store; the lookup was wrong.
Found by aggregating `gaps.jsonl` + the `diag.errs` the ATS itself printed,
then unit-testing the shipped `bankValue`/`infer` against the REAL field names
pulled out of the ledger. That offline test loop caught two hazards in the new
code before it ever touched a form — do it before any live run.

1. **`learned.json` could never answer a free-text question.** In `infer()` a
   learned answer was returned only via `fuzzyOpt(opts, v)`, which needs a
   matching OPTION. The LLM branch immediately above always had the
   `if (!opts.length) return llm` fallback; the learned branch silently did not.
   Free-text was the single biggest `needs-inference` bucket.
   **Guard it**: a bare Yes/No must NOT be written into a free-text box for a
   wh-question — "*What percentage of the time are you willing to travel?"
   matches the learned key "willing to travel" -> "Yes". Allowed only when the
   label reads as a yes/no question ("Do you...", "Have you..."), never
   what/which/how/when/where/who/why.
2. **`offsite3`'s text path never consulted `learned.json` at all** — only
   `bankValue` and the LLM cache.
3. **`bankValue` answered work-authorization questions with "Ontario".** The
   state rule was unbounded `/state|province/` and "United **States**" contains
   "states", so *"Are you legally authorized to work in the United States?"*
   returned the province. The text path consults `bankValue` FIRST, so that got
   typed into the field. Fix: `\bstate\b` — no word boundary before the
   trailing "s", so it cannot match "states", while still matching "State *",
   "*State:", "State/Province", "Select a state".
4. **`/degree/` was tested before `/major|field of study/`**, so "Field of Study
   in your Undergraduate degree" answered "Bachelor's Degree". Field-of-study
   wording is the more specific signal — test it first. Related: a `/graduat/`
   rule also matches "under**graduat**e"; require the whole word "graduation".
5. **Graduation dates gapped although known.** Only year *selects* had a
   handler, so `Expected Graduation Date` as a text/date input fell through
   while `answers.json` had `end_month_year` all along.
6. **The sponsorship rule assumed Yes/No options.** Ashby offers
   `["I am authorized to work in the US without sponsorship", "I am on an H-1B
   and need a transfer", "I need H-1B sponsorship (new application / lottery)",
   "Other"]` and `find(/^yes/i)` matches none of them. The truthful answer is
   **"Other"**: a student needs J-1/F-1, so selecting the H-1B option would be
   FALSE. The rule now takes a generic "need sponsorship" option but explicitly
   excludes any naming a visa class we do not need, and still returns null when
   no option is truthful. Do not turn "Other" into a blanket fallback.
7. **Class standing is DERIVED, never stored.** "In summer 2027, what year will
   you be rising into?" — `education[0].start_year` is 2024, so fall of year Y
   is standing (Y - 2024 + 1); 2027 -> Senior. A static `learned.json` entry
   would be right for 2027 and wrong for every other year, so the rule reads the
   year out of the question and returns null when none is stated.
8. **The `isCounter` guard only ran on the ancestor climb.** Oracle Cloud renders
   a live character counter next to the control; when it sits inside the
   `<label>`, `label[for=]`/`closest(label)`/`aria-label`/`placeholder` all
   bypassed the guard and the label became the literal string **"1000"**. That
   one mis-read label blocked **76 of 79** Oracle `needs-inference` jobs — the
   biggest single blocker in the ledger. Apply the guard to EVERY label source.
9. **Internship date-window options.** "May 24, 2027 - August 20, 2027" /
   "None of these dates work for me". Every concrete window is truthful; take
   the first real one and NEVER the opt-out, which withdraws the application.
   Bare year lists have no month+day and so cannot match.

### Real submissions were being reported as failures (again)

Lever redirects cross-origin to `company.com/confirmation?LeverAppId=...`
*after* the 30s confirmation window closes, so the proof landed in the `diag`
captured moments later and was never re-read. Re-test that final snapshot before
declaring failure. Keep it STRICTER than the in-loop check: require no validation
errors, and either a confirmation-named URL that differs from `url0` or
confirmation TEXT in the body. Validated against all 187 diag-bearing records —
exactly 2 flipped, both genuine Lever confirmations, zero false positives.
**Always back-test a confirmation-widening change against the whole ledger before
shipping it**; false SUBMITTED is the one outcome worse than a missed application.

### Error-driven repair: the ATS names the field, so read it back

Ashby prints "Your form needs corrections / Missing entry for required field:
**Email**" on forms we counted 9/9 filled with zero gaps. `repairRequired`
existed but ran BEFORE submit, ignored the error text, and never consulted
`learned.json`. `repairFromErrors` now parses the message, refills with real
keystrokes (a plain `fill()` leaves Ashby's React state unset — which is exactly
why the field reads filled to us and empty to them), and resubmits once.
Hazards found while writing it:
- **Never blind-`check()` a radio/checkbox** whose matched label is the GROUP
  question. "Are you legally authorized to work in the United States?" would have
  had an arbitrary Yes/No asserted. Leave radios to the group path, which
  resolves through `infer()` with the real options.
- **Split on the phrase, do not regex-capture past it.** A greedy `[^.]{3,90}`
  swallows Ashby's NEXT "Missing entry for required field:" and emits junk names
  ("Which off", "ll required fields", "value"). Precision over recall: a wrong
  field name can match the wrong control.
- A typeahead must be **committed** (pick the suggestion), and a `<select>` must
  be answered from **its own options** — handing it a raw bank string
  ("2027-01-04" into a "March 2026 / April 2026" month list) always fails.

### Timeouts were masking real diagnoses

`apply3`'s per-job budget was hardcoded at 120s (now `JOB_TIMEOUT`). Jobs died as
`err:timeout` at 1/20, 25/35, even 17/18. Raised to 300s, all five re-ran to
completion and reported their ACTUAL blocker (`no-submit-btn`, each one a single
answerable dropdown). **Check whether a timeout is hiding a diagnosis before
treating the reported status as real** — and when a status count rises after a
change, confirm against the previous ids that it is better diagnosis rather than
a regression.

### pkill -f kills your own monitor

`pkill -f "apply3.mjs"` matches any watcher shell whose command line contains
that string — the same self-match trap the SKILL notes for `pgrep`. It silently
killed the progress monitor alongside the run. Kill by PID instead:
`ps -eo pid,args | awk '$2 ~ /node$/ && $3=="apply3.mjs" {print $1}'`.

### Parallel offsite3 workers need tab OWNERSHIP (2026-09-24), or they sabotage each other

Four offsite3 shards on one Chrome looked like 4x throughput. They actually
produced "Target page closed", `scan-failed` and `ERR_ABORTED` on nearly every
job, and records carrying ANOTHER job's ATS URL (Hearst -> Grant Thornton's
Oracle posting). Cause: `c.waitForEvent('page')` and `c.pages()` are
context-wide, so a worker adopted any new tab, and its end-of-job cleanup
closed every non-JobRight tab, including the other workers' live forms. Fixed
with a per-job `OWN` set: a new page is ours only if its opener is ours or its
URL carries `jr_id=<this job>`; the popup is taken from `p.on('popup')`;
cleanup closes owned pages only. **Check before scaling any worker count:** do
records' `jr_id` values match their `id`?

### (Superseded above for offsite3 x N) Concurrency is fine; serialize only where the data depends

`apply3` and `offsite3` run simultaneously against the same Chrome without
contention (~12 tabs, no CDP instability). The EASY-APPLY-first rule exists
because the offsite batch is BUILT from what EASY APPLY defers — it is a data
dependency, not a browser one. Jobs already marked `offsite-deferred` by a
previous run can be worked in parallel with a fresh EASY APPLY pass.

### A fix living in only ONE of the two scripts (2026-09-22)

`apply3` died at job 60 of a 403-job run with:

    ProtocolError (Page.handleJavaScriptDialog): No dialog is showing
        at DialogManager.dialogDidOpen

A page opened a JavaScript dialog. With no `dialog` listener registered,
playwright-core auto-handles it internally, and that internal path throws on a
tick **no try/catch of ours can reach** — it surfaces as an unhandled rejection
and kills the process. Every job after 60 was lost.

**`offsite3` already had the complete fix** — `process.on('uncaughtException')`,
`process.on('unhandledRejection')`, AND `armDialogHandler` (a `ctx.on('page',
pg => pg.on('dialog', d => d.dismiss().catch(()=>{})))`) — with a comment
describing this precise failure. It was found and fixed there in an earlier
session and never ported. That is why offsite3 ran for hours through the same
conditions while apply3 kept dying.

**Lesson: when you fix a harness-level bug (crash guards, reconnect logic,
dialog handling), check whether the OTHER script has it.** The two scripts
share no code; they only share bugs. Worth grepping both for
`process.on(`, `armDialogHandler`, `reconnect`, `DEAD_BROWSER` before assuming
a protection exists.

**Do not blindly copy offsite3's handler.** It calls `process.exit(1)` because
`run_offsite_resilient.sh` restarts it; `apply3` has no wrapper, so exiting
still loses the run. apply3's version classifies instead: benign async/dialog
protocol errors (`No dialog is showing`, `Target page, context or browser has
been closed`, `Session closed`) log `RECOVERED` and continue; anything else
still exits non-zero rather than limping on in unknown state.

### Retry caps are already handled - check before adding your own skip-list

A job that kept reappearing looked like a requeue-filter bug. It was not:
`apply3` skips a job when it is TERMINAL *or* when `attemptCount >=
MAX_ATTEMPTS` (default 3). The job simply had 2 prior records and was on its
third and final attempt. An explicit skip-list for it was redundant. Count the
existing records before concluding the dedupe is broken.

## apply3's `too-sparse-refused 0/0` was a LOADING RACE (2026-09-22, later session)

`rec.sparse` (modal count + input count + the modal's text head, recorded at the
refusal) named it on its first job:

    {"modals":1,"inputs":0,
     "head":"Apply to Quantitative Intern @ Optiver ... Preparing Your
             Application... Loading the application form."}

The modal WAS open. apply3 clicked EASY APPLY, waited a fixed 4000ms, and
scanned straight through JobRight's own loading state, so every slow-rendering
form scored 0/0 and was refused as sparse. Same job, next run:
`too-sparse-refused 0/0` -> `err:timeout 32/38`. Across one 11-job pass this
turned six 0/0 refusals into forms filled 20-38 deep.

**Three traps in fixing it, in the order I hit them:**
1. Breaking the wait as soon as the modal has >=1 input returns EARLIER than the
   old fixed 4s wait did, and the extension's "Start to Autofill" button is not
   mounted yet. Skipping it drops the whole prefill: Interstates went
   `no-submit-btn 18/21` -> `too-sparse-refused 1/20`.
2. `.some(e => e.value)` as the "already prefilled" test is satisfied by ONE
   pre-filled field (email). Lyft came out 1/28. Require >= 3.
3. The autofill button can mount LATER than the first field, so a single check
   still misses it. Make it a bounded loop (5 x 3s) that exits immediately once
   the form has >= 3 filled or fewer than 5 fields total.

Lyft's arc across these: `0/0` -> `1/28` -> `36/43`.

## `no-submit-btn` on EASY APPLY is not a locator bug (2026-09-22)

JobRight does not render Submit until the form is COMPLETE, so `no-submit-btn`
is the honest "still has gaps" state. Measured over the whole ledger:

- 36 `no-submit-btn` records, **every one** with >= 1 unresolved gap, **zero**
  with none.
- 130 of 150 `SUBMITTED` records had zero unresolved.

`rec.btns` comes back `[]` because the modal genuinely contains no visible
clickable, and `rec.submitLike` (any LEAF element whose own text is "Submit")
comes back `[]` too. Do not widen the selector; close the gap. Confirmed by
Interstates: adding its SMS-consent answer moved it straight from
`no-submit-btn` to a clicked Submit.

Corollary: `rec.btnsPage` captures JobRight's nav, which contains the
authoritative counter as `Applied N#`. That is a free counter read with no tab
navigation - which matters while offsite3 is live.

## Ant Design dropdowns are VIRTUALIZED - you only ever see ~9 options (2026-09-22)

The single highest-value EASY APPLY find of the session. A required `*State`
select recorded its options as:

    ["AL","AK","AZ","AR","CA","CO","CT","DE","DC"]      <- nine, for 50 states

`rc-virtual-list` keeps only about nine option nodes in the DOM at a time, so
the option reader could never see past the ninth, and **any answer further down
the list was unmatchable** - on every long select in this path: states,
countries, year lists. After scrolling `.rc-virtual-list-holder` and
accumulating until no new text appears, the same field on the same job reported
30+ options.

Two things this needs, not one:
- **Reading** requires scrolling the holder and accumulating.
- **Clicking** requires scrolling the chosen option BACK into the DOM first.
  Reading an option is not the same as being able to click it.

Record `nopts` (the full count seen) next to the capped `options` sample, or you
cannot tell "the reader reached the end of the list" from "the record's own
slice(0,30) truncated it".

A US-only `State` list against an Ontario address still has no truthful answer
and must stay gapped - same as the documented cai.io/Paylocity case. Now that
the whole list is visible, apply3 takes Ontario if present, else an explicit
escape hatch (Outside the US / Non-US / Not Applicable / Other) if the form
offers one, else gaps. It never invents a US state.

## Never upload the resume for a document you do not have (2026-09-22)

Only `resume.pdf` and `transcript.pdf` exist on disk, and the upload handler
attached **resume.pdf to any file input** not matched by
`/transcript|academic record/`. A "research supplement" (Viking), writing
sample, portfolio, cover letter or references field would therefore have
received the RESUME. Sending the wrong document is worse than leaving the field
empty - the same class of error as filling a country field with "No". Those
labels are now logged as gaps.

## Yes/No answers cannot match `["I confirm","I do not confirm"]` (2026-09-22)

Viking gapped a 12/14 form on "*This internship is based in New York, NY and
requires in-person presence. Please confirm your understanding", because
learned.json answers that class "Yes" and fuzzyOpt has no path from "Yes" to
"I confirm". Added a rule that picks the affirmative option when the question
states a fact ABOUT THE ROLE and asks to confirm/acknowledge/understand.

**It must stay guarded.** `CONFIRM_NEVER` blocks it whenever the sentence
asserts something about the CANDIDATE's credentials or status - clearance,
work authorization, sponsorship, visa, degree, licence, certification, years of
experience, GPA, convictions. "This role requires a security clearance, please
confirm you hold one" has to remain a gap; those topics are on `never_infer`.

## Do not run apply3 and offsite3 concurrently (2026-09-22)

The skill's workflow is sequential for a reason. Running both against the same
Chrome produces an intermittent failure where the JobRight modal vanishes
mid-job:

    txtTrail ["0:gone-before-scan"]   phase text:0   sparse {"modals":0}

i.e. the modal was gone before the text loop's first scan, so neither the
text loop's click/type/Tab nor the guarded Escape in the select loop is
responsible. One job's history across builds:

    35/41 -> 1/40 -> 34/41 -> 34/41 -> 33/41 -> 2/40

Four of seven attempts were fine, so it is not a build regression. offsite3
opens a new ATS tab for nearly every job, which changes the active tab, and the
extension's autofill popup does not survive that. Note `total` reads 41 when
the modal survives and 40 when it does not - a changed `total` on the same job
is the tell.

**CONFIRMED.** All three affected jobs were re-run on the same build with
offsite3 STOPPED and nothing else driving Chrome. Every one recovered:

    Data Analytics Intern  HAI Group   2/20  ->  16/21
    Research Analyst Intern HAI Group  2/20  ->  16/21
    AI/ML Research I                   2/40  ->  34/41

No modal vanished. **This needs no code fix** - it is an operational error, and
the cost of getting it wrong is silent: the jobs still produce records, they
just produce bad ones that burn MAX_ATTEMPTS slots. Run the two passes
sequentially, as SKILL.md's workflow already implies.

## Two mistakes of mine worth not repeating (2026-09-22)

**I loosened a load-bearing guard without reading this file first.** I changed
offsite3's submit-size floor from `h < 14` to `h < 6` + `isVisible()`, arguing
that a 65x11 SmartRecruiters "Submit" was a real button refused by an arbitrary
threshold. The section "Submit size guard: 5px was too loose" above documents
that exact button, from earlier the same day: it is FINE PRINT, and clicking it
short-circuits the wizard walk to the real terminal Submit. The 7
`submit-btn-not-visible` records were the guard WORKING. Reverted, with a
comment at the line pointing here. The skill's instruction to read this file
BEFORE changing a script is not a formality.

**Delete ledger rows by ID, never by a shape filter.** Removing one record my
own regression had produced, I filtered on
`too-sparse-refused AND filled==1 AND total>=10` and also deleted three records
from earlier runs (Anduril 1/22, HAI Group 1/20, AI/ML 1/40) that were genuine
outcomes under older code. Restored from the backup and dropped only the one
row by id.

## Record WHICH element tripped a captcha skip (2026-09-22)

`skip-captcha-visible` carried no evidence, so a legitimate skip and a false
positive looked identical. `capWhy` now records the matching iframe/element and
its rendered box at all three decision sites. It immediately settled a case I
had guessed wrong:

    explore.jobs.netflix.net (Eightfold), 46-field form
    capWhy = "iframe .../recaptcha/api2/anchor?ar=1&k=... 256x60"

An `api2/anchor` iframe at 256x60 is the standard rendered v2 "I'm not a robot"
checkbox - a real interactive captcha, so the skip is correct. Netflix/Eightfold
and `*.applytojob.com` (JazzHR) are both genuine captcha walls; no yield is
being lost there. Read `capWhy` before suspecting a false positive.

## A radio `.check()` that reports success is not a committed answer (2026-09-22)

Huawei/Recruitee, `submit-unconfirmed 6/10`, with the late diag naming it:

    errs   ["This field is required and can not be left empty."]
    blanks ["Are you currently legally entitled to work for Huawei in Canada? * Yes No",
            "Are you open to work fully onsite? * Yes No"]

Both answers are in `learned.json` and **no gap was logged**, so `infer()`
resolved both. `fillRadios`' first strategy (`#id` + Playwright `.check()`)
returned true, the framework re-rendered and dropped it, and the existing
label-click / trusted-click fallbacks never ran because they are gated on
`if (!done)`.

Fix: VERIFY the group (`[...radios].some(r => r.checked)`) and, when a reported
success did not stick, run the remaining strategies anyway - ancestor-label
click, trusted click, then an in-page `r.click()`. Set `done` from the
verification, never from what a strategy claimed.

Same class as the `spl-input` finding above ("web components commit on real
input events and blur, not on a `.value` assignment"). `repairFromErrors` still
refuses to touch radios blindly - that stays correct, because repair does not
know WHICH option is wanted; `fillRadios` does.

## `err:timeout` with no evidence, and where the time actually goes (2026-09-22)

`err:timeout` recorded `-/-` and nothing else, so six minutes of wall clock
left no trace. offsite3 now sets `PHASE` as the job proceeds and writes
`phase` + `elapsed` onto the error record.

First two firings both read `phase:"fill"`, `elapsed:600` — the ENTIRE budget
inside `fillAll`, not the reveal and not the wizard walk. That exonerated the
change I had been suspecting ("Continue to Application" making the wizard
actually walk). On a ~90-field Phenom form where every combobox does
pressEsc + open + read + a possible typed seed with waits, it is plausible.

Raising `JOB_TIMEOUT` 360000 → 600000 converted a job that had timed out at
`-/-` on two consecutive passes into a real record: `too-sparse-refused 2/91`,
with `sparse {total:91, filled:2, grew:false}`. The timeout had been hiding a
much more useful fact — fill coverage of 2 out of 91 fields.

**A fill budget is the right next step, but not the obvious implementation.**

    // tempting, and wrong
    unresolved = await withTimeout(fillAll(tab), FILL_BUDGET).catch(() => []);

That abandons `fillAll` mid-operation; its pending Playwright calls keep
running against the page while the submit path starts using it. `BENIGN_ASYNC`
would absorb the rejections but not the interference. Pass a deadline INTO
`fillAll` and check it between fields instead, so nothing is ever abandoned
mid-operation.

## `proof/<id>.png` covers only about half of SUBMITTED (2026-09-22)

    SUBMITTED: 88   with proof screenshot: 47   marked on JobRight: 80

The screenshot is taken with an 8s timeout immediately after submit, and many
post-submit pages are still redirecting, so it silently fails about half the
time. The `try {} catch {}` around it is intentional — a failed screenshot must
never fail a real submission.

Do not "fix" this by trusting `proof` as the audit trail. `marked` (JobRight's
own "Yes, I applied" click) covers 80 of 88 and is what moves the Applied
counter, which is the authoritative number. If proof coverage ever does matter,
raise the timeout and take the shot AFTER the confirmation wait, not before it.

## Environment

- **Node**: `~/.local/share/mise/shims/node`. Homebrew node is broken (`libsimdutf.34.dylib`).
- **Chrome must be launched by binary path**, not `open -na`. `open -na` breaks CDP with
  `Browser.setDownloadBehavior: Browser context management is not supported`.
- **Chrome 136+ refuses `--remote-debugging-port` on the default profile dir.** Use the
  dedicated `~/.jobagent/chrome-profile`.
- Attach with `chromium.connectOverCDP('http://localhost:9222')`. Launching Playwright's
  own Chromium gets you no extension and no session — useless here.

## Clicks and the DOM

- **Trusted clicks only.** `el.click()` from page JS is `isTrusted:false` and the JobRight
  extension ignores it. Use Playwright's `.click()` (dispatches via CDP Input).
- **Reactour overlay** `#___reactour` (z-index 99999) swallows clicks and re-renders on
  every page load. DOM-remove it after each navigation.
- **The Autofill button lives in an open shadow root** under
  `PLASMO-CSUI#jobright-helper-plugin`. Playwright locators pierce open shadow roots.
- **Ant Design selects** hold their value in `.ant-select-selection-item`, *not*
  `input.value`. Reading `input.value` reports every select as empty.
- **Checkboxes/radios**: use `.checked`. Their `value` defaults to `"on"`, so a value
  check counts unchecked boxes as filled.
- **Virtualized lists scroll in an inner container**, not the window. JobRight's is
  `index_jobs-page-main-content__qd__a`. Window-scrolling found 8 of 652 jobs.
  Harvest scrolls both the window and every `div` with real overflow.
- **SPA wizards may never change URL.** Detect step advance via the `"Step N of M"`
  label changing, not navigation.

## Confirmation

- **Scope submit confirmation to the modal.** Matching `document.body.innerText` false-
  positives on JobRight's nav text `"Applied 1621"` and stamps every job SUBMITTED.
- **Only the JobRight Applied counter is authoritative.** Button presence and cached
  counters both lied; the Applied list was correct.
- Same class of bug: checking "expired job" text against full-page innerText matches
  stale scrollback. Scope to the newest bubble only.

## Captcha classification — the single biggest yield loss

- **reCAPTCHA v3**: `grecaptcha-badge` + a **0x0** anchor iframe. Invisible, needs no
  interaction, completely harmless. Treating any recaptcha iframe as blocking skipped a
  large share of otherwise-applyable jobs.
- **reCAPTCHA v2 / hCaptcha**: a *visible* checkbox or `bframe` challenge. Blocking.
- The classifier must gate on rendered size:
  ```js
  const big = e => e.offsetWidth > 10 && e.offsetHeight > 10;
  ```

## Answer polarity

- "Will you require sponsorship?" → truthful **Yes** (needs J-1).
- "Are you legally authorized to work in the US?" → truthful **No**.
  Opposite polarity, overlapping wording. **Test `SPONSOR` before `WORK_AUTH`** — the
  sponsorship phrasing contains "work authorization", so the other order answers both
  "No", which is a false statement on the application.
- EEO / self-identification → always decline.
- `never_infer` list in `answers.yaml` is absolute: citizenship, work authorization,
  sponsorship. These come from the bank, never from a guess.
- Grad year is **2028**. The JobRight profile says 2026 and is wrong.

## Field labels

Required fields showed as `(unlabeled)` and blocked submission. The `LBL_SRC` resolver
tries, in order: `label[for]` → `closest('label')` → `aria-labelledby` → `aria-label` →
`placeholder` → up to 4 ancestors with text <220 chars → back 3 siblings → humanized
`name`. Also: **match regexes against the untruncated label** — truncating to 45 chars
made `/transcript/i` miss a 51-char label.

## Gap resolution

Read each dropdown's question text **at the moment it opens**, one gap per pass with a
re-scan between. A snapshot taken up front desyncs and applies question A's answer to
question B's dropdown.

## Don't bother

- `Start Fixing` on JobRight's Agent tab does nothing under automation — it depends on
  the extension popup on the employer's site.
- The right-hand panel on the Agent tab is "Confirm Resume" (a preview), not an editable
  form.
- Tesla's Akamai WAF returns domain-wide `Access Denied` after repeated hits. Hard-skip;
  do not attempt evasion.
- Don't run a tab reaper during a live pass — it kills tabs mid-job
  (`Target page, context or browser has been closed`). Tab buildup is the lesser problem.
- Guard clauses must come **before** the `continue`, not after.

## The silent-skip family (2026-09-12) — READ THIS FIRST

Four separate bugs on ONE Lever job, each of which reported a plausible success or
skip while dropping the work on the floor. The job was fillable the whole time; the
instrumentation was lying. When yield looks like zero, suspect this shape first.

1. **Invisible hCaptcha counted as blocking** → logged `skip-captcha-visible`.
   hCaptcha/reCAPTCHA inject full-viewport host iframes at `visibility:hidden`, and
   invisible-mode containers lay out at height 0. `offsetWidth/Height > 10` passes on
   both. `big()` must also check `visibility`, `display`, `opacity`, and viewport
   intersection. Only `hcaptcha.*(checkbox|challenge)` frames are real; `.../static/`
   is present on every hCaptcha page regardless of mode.

2. **Question text read from the wrong DOM level** → inference received `"Yes No"`.
   Lever nests the question ~5 ancestors above the input; every closer ancestor
   contains only the option labels. `closest('div[class*=field]')` lands on
   `div.application-field` whose text is just `"Yes No"`. `QUP()` walks up until the
   ancestor's text, with the option labels stripped out, still has >= 8 chars.
   This one is dangerous: it fed a blank-looking prompt to a `never_infer` question
   ("Are you legally authorized to work...").

3. **Radio clicks gated on an `id` the ATS never renders** → logged `READY`, no gaps.
   Lever renders **0 of 14** radios with an `id`. `if (t?.id) ...check()` computed the
   right answer and discarded it. Address radios by `name` + option index, and if the
   click fails, LOG A GAP — never fall through silently.

4. **A hidden 0x0 decoy button won the submit selector** → `submit-unconfirmed`.
   Lever ships `<button type=submit id=hcaptchaSubmitBtn class=hidden>` BEFORE the real
   one, so `.first()` on a `button[type=submit]` selector clicks nothing and the
   `.catch(() => {})` swallows it. Select the LAST visible submit/apply button, reject
   anything under 5x5, and record which button was clicked into the ledger.

### Required-field detection
`el.required` / `aria-required` is NOT sufficient. Lever marks required fields with a
`✱` glyph in the container text and a `required-field` class on the wrapper. Checking
only the attribute reports `fin.req = []` and yields a false `READY`. Diagnostics scan
`[class*=required], fieldset, .application-question` for a `✱` plus an empty control.

### Other fixes from the same session
- **High school vs degree graduation year.** A bare year dropdown is ambiguous:
  "Year of High School Graduation" and "intended graduation year" are both all-years
  lists. Defaulting every one to the degree year (2028) puts FALSE info on the form.
  Classify the question first (`high school` -> 2024, `graduat|degree|program` -> 2028)
  and log a gap when it cannot be told apart. See `YEARS` in offsite3.mjs.
- **Year lists carry placeholders.** `Select...` and `Other` sit beside the years, so an
  "all options are years" test fails. Strip placeholders before the test.
- **Consent/cookie banners** sit `fixed` above the form and intercept the submit click.
  `dismissBanners()` runs before filling.
- **Workday** renders no form without an account; it was hiding inside `no-form-found`.
  Now labelled `skip-workday` (user rule: skip Workday outright).

### Debugging rule earned here
On `submit-unconfirmed`, do not guess. The ledger `diag` block captures the URL, visible
validation/`role=alert` text, and every required-marked-but-empty field. Two rounds of
that found bugs 3 and 4 in minutes after hours of guessing.

## Do not probe while a pass is running
`offsite3.mjs` closes every non-jobright.ai tab after each job. Any diagnostic tab you
open mid-run dies with `Target page, context or browser has been closed`. Stop the pass
first, or accept that probes will be reaped.

## "Form found" cannot be judged by input count
Eightfold (Microsoft, Lockheed, New York Life) and similar career portals land on a job
SEARCH view carrying hundreds of facet checkboxes and filter boxes. A raw
`input,select,textarea` count reads as a large form when there is no application form at
all, which sails past a `total < 5` reveal guard and then fails as
`too-sparse-refused`. Gate the Apply-reveal on how little is FILLED (`filled < 3`), not
on input count. Related: counting a checkbox as filled via `value` is wrong - unchecked
boxes default to `value="on"`. Always use `.checked`.

## CDP breaks with zero open tabs
If every page/tab is closed (e.g. a script is killed mid-run before its cleanup runs),
`chromium.connectOverCDP()` fails with `Protocol error (Browser.setDownloadBehavior):
Browser context management is not supported` even though `/json/version` responds fine.
Fix: open one tab directly via the CDP HTTP endpoint before connecting with Playwright:
  curl -s -X PUT "http://localhost:9222/json/new?about:blank"
Then connectOverCDP works normally. Do not assume this is the `open -na` launch bug -
check `curl -s http://localhost:9222/json/list` for target count first.

## Process-management traps that wasted most of a session (2026-09-17)

None of these are bugs in the automation logic. They cost hours anyway because they
produce symptoms that look exactly like real bugs. Check this list before touching
code when a run looks "stuck" or "dead".

1. **`nohup ./script > log 2>&1 &` buffers stdout when not attached to a TTY.**
   Console.log output can sit in a buffer and never appear in the log file until the
   process exits (and if it never exits cleanly, it may never appear at all) - while
   the ledger, written with synchronous `fs.appendFileSync`, keeps recording the real,
   current truth the entire time. A run that looks like it died silently after printing
   one line may actually have kept working correctly for many jobs. **Always check the
   ledger (`offsite3.jsonl`) and the JobRight Applied counter, never the stdout log
   file alone, before concluding a run failed.**

2. **`await browser.close()` on a `connectOverCDP()` connection can hang forever** and
   never return, even after the script's own last `console.log` (its very last line of
   real work) has already printed. A process that's still in the OS process table is
   not proof the job queue is still being worked - check whether the *log* shows the
   final `processed=N submitted=M` summary line before treating a live PID as "still
   running work." If it's hung on close(), the work is done; just `kill -9` it and move
   on, don't relaunch redundant work.

3. **Launching a second wrapper/script instance while an earlier one's retry loop is
   still alive is invisible from a single `pgrep` check** taken right after launch - a
   wrapper with its own internal restart loop (sleep + retry) can look "finished"
   between attempts and then resume, colliding with a freshly-launched second instance
   over the same Chrome tabs. This reproduced the exact "browser connection died"
   symptom repeatedly and was mistaken for a Playwright/Chrome bug for a long time
   before the real cause (two `run_offsite_resilient.sh` processes, started minutes
   apart, both spawning `offsite3.mjs` against the same CDP endpoint) was found via
   `ps -o pid,ppid,lstart,command -p <pid>`. **Before launching any new attempt, run
   `pgrep -fl` for both the wrapper and `node offsite3.mjs`, and if anything matches,
   kill it and re-check 5-10 seconds later before launching anything new** - a single
   instantaneous "clear" check is not sufficient given retry-loop sleep windows.

4. **The automation Chrome profile is not meant to run for days.** After a multi-day
   uptime, `ps aux | grep "user-data-dir=.../chrome-profile"` showed 30+ helper
   processes and 16-18GB RSS for what should be a 1-3 tab browser, and system-wide free
   memory dropped to ~130MB, which is consistent with (though not conclusively proven
   to be the sole cause of) intermittent `node` process deaths with zero output and no
   crash report (a signature consistent with an OS-level memory-pressure kill, which a
   JS `uncaughtException`/`unhandledRejection` handler cannot catch or log). Killing
   just that Chrome instance (`pgrep -f "user-data-dir=.../chrome-profile" | xargs
   kill`) and relaunching via `bin/chrome.sh` reclaimed several GB and preserved the
   login session (it's on-disk, not in-memory). Consider restarting Chrome at the start
   of any session where it's been running more than a day, before diagnosing anything
   else.

5. **A real internet dropout produces `net::ERR_INTERNET_DISCONNECTED`** on every
   `page.goto()`, which looks identical in the ledger to a code bug (a wall of
   `err:page.goto...` entries). Check `curl -s -m 5 -o /dev/null -w "%{http_code}"
   https://jobright.ai` before assuming the automation itself regressed.

6. **The one launch pattern that behaved reliably all night**: a plain foreground
   `~/.local/share/mise/shims/node offsite3.mjs > log 2>&1` with no `nohup`, no trailing
   `&`, and no explicit `run_in_background` - just letting the harness's own timeout
   auto-background it when it runs long. Every explicitly-backgrounded variant
   (`nohup ... &`, `run_in_background: true` set directly) was where the confusing
   symptoms above showed up. Prefer the plain form for single/small isolated test runs;
   reserve explicit backgrounding for large batches where the ledger, not the log, is
   how you'll check progress anyway.

## 2026-09-20/21 session — six real bugs, and one ATS that beat me

All six below were sitting behind a status that looked like a legitimate skip.

1. **`apply3.mjs` pressed Escape with no dropdown open, closing the whole modal.**
   The unresolvable-dropdown branch did an unconditional `p.keyboard.press('Escape')`.
   With no Ant dropdown open that keystroke closes the JobRight modal; the next
   `gapScan()` returns `null` and `s.reqGaps` / `s.filled` threw. 20 jobs died as
   `err:Cannot read properties of null` with forms already 23/26 filled. Guard the
   Escape on an actually-open `.ant-select-dropdown`, and never dereference a
   re-scan without a fallback. Retry after the fix: 0 errors, +8 submits.

2. **A cross-origin confirmation redirect was read as failure.** Lever submits by
   navigating to `company.com/confirmation?LeverAppId=...` (or `.../thanks`). That
   tears down the execution context, so `tab.evaluate()` throws *while the
   submission is succeeding* — and the loop did `if (!st) break`, reporting a real
   application as `submit-unconfirmed`. `tab.url()` reads browser-side and still
   answers mid-navigation: poll it and `continue` instead of breaking. Confirmed on
   two live jobs that had genuinely gone through.

3. **A fact in `answers.json` but not in `BANK` is invisible to the live path.**
   GPA was the case this time (Ashby names the single blocking field in its own
   validation text: "Missing entry for required field: What is your GPA?"). This is
   the dual-store trap SKILL.md warns about; it has now bitten twice.

4. **Typeahead comboboxes bailed silently AND logged no gap.** A location/school
   typeahead renders zero options until you type, so `if (!opts.length) { pressEsc;
   continue; }` left a *required* field empty with nothing in `gaps.jsonl`. Seed it
   from `bankValue(label)` and take the first suggestion; if you still can't, push
   an `unresolved` entry so it's at least visible.

5. **The combobox option list was queried page-wide, so options leaked between
   fields.** Once clicks were made reliable, dropdowns left open earlier in the pass
   contributed their options to later ones: a Paylocity *country* field was offered
   `["Yes","No","Yes*"]` and was about to be answered `"No"`. Scope the query to the
   last visible `[role=listbox]` and `pressEsc` before opening the next box. This
   one was writing wrong data, not just failing.

6. **Two statuses were lying about the cause.**
   - Oracle CandidateExperience gates every application behind an emailed 6-digit
     PIN (`APPLY NOW` -> `/apply/email`). The PIN screen has exactly 2 inputs
     (`primary-email` + a honeypot), so it logged as `too-sparse-refused` at 1/2 on
     ~16 jobs. It is a login wall; label it `skip-login` so it leaves the reachable
     denominator. The "Enter verification code digit N of six" rows in `gaps.jsonl`
     are this screen.
   - `skip-captcha-visible` fired when the reveal had found no form at all (every
     New York Life job is an Eightfold `careers/?query=NNNNN` *search* page carrying
     a sitekey div). Require `total >= 3` before captcha is allowed to block —
     captcha is only a reason to walk away from a form you could otherwise fill.

### Diagnostics worth keeping
`no-submit-btn` now records `req` (required-and-empty), `btns` (visible controls with
ids) and `navErrs` (the ATS's own validation text), and `fillCycle` records a `wiz`
trail of the steps it actually visited. Every inference below came from those three
fields rather than from re-running blind — add the marker before you theorise.

Two Playwright traps found this way:
- **`filter({ hasText: /regex/ })` matches raw `textContent`, which is NOT
  whitespace-normalized.** An anchored `/^next step$/` never matched Paylocity's
  `"\n Next Step\n"` button even though it was visible and enabled. Normalize in JS
  (`innerText().replace(/\s+/g,' ').trim()`) when you need an anchored match.
- **`.first()` on a text selector can pick a hidden duplicate.** ADP renders two
  "Apply" elements; the first one's click just times out, burning the whole reveal
  attempt. Prefer `.filter({ visible: true })`.

### Paylocity: still unsolved, don't repeat these steps
Reachable state: form fills to ~45/80 and every validation error it reported is now
cleared, but it will not advance and does not submit.
- Step 1's only control is `Next Step` (`id=btn-submit`, and **not** `type=submit`),
  so the submit hunt finds nothing. It is a wizard, not a missing selector.
- Paylocity parses the uploaded resume itself into work-history rows (`wh: 0` on a
  fresh load, 3 rows after upload) and sometimes leaves one with an empty
  "Start Date (required)" whose `e.required` is **false** — so `scan()` never flags
  it. `pruneIncompleteRows()` deletes the row the ATS failed to populate rather than
  inventing employment dates; that cleared the Start Date error.
- Its SMS-consent control is a `div[role=combobox]` showing `--`, and it only renders
  **after** a mobile number is entered. Its nearest non-empty text is its own
  placeholder `--`, so `infer()` was being asked to answer the string "--". Climb
  ancestors for a label >=15 chars that isn't all dashes.
- `--` was not filtered as a placeholder *option*, so a Yes/No question looked
  like a 3-way choice and `infer()` declined it.
- **Do NOT re-enable `expandRepeaters` (`REPEAT=1`) casually.** `fillAll` runs once
  per wizard step, so an unguarded expander clicked "Add Work History" on every step
  and built SIX entries (`workHistory.startDate.0..5`). Each entry adds its own
  required Country/State/**County** block, and `county` is explicitly
  `null` + "Not known. Gap it." in `answers.json` — so every extra row made the form
  strictly less submittable (75/125 with 12 unsatisfiable required fields).
- Where it now dies: `wiz` ends `adv-stuck0`. `Next Step` is clicked (normal click
  succeeds), polled for 15s, and the page signature is unchanged with **no visible
  validation error** — yet on a bare unfilled page the same button does produce
  errors. So the button works; something about the filled state or the click context
  doesn't. That is the next thing to look at, and it needs live observation of the
  click, not another selector change.

## Playwright `connectOverCDP` hangs while a batch is running (2026-09-21)

Reading the Applied counter with a `playwright-core` probe that calls
`chromium.connectOverCDP(...)` + `ctx.newPage()` **hangs indefinitely** (no
error, no timeout) whenever `offsite3.mjs`/`apply3.mjs` holds the browser — and
it stayed hung even after the batch was killed and tabs were pruned from 11 to 4.
`/json/version` and `/json/list` answer fine the whole time, so the browser is
NOT dead; it is specifically the Playwright CDP handshake that wedges.

Do not debug this by closing tabs or restarting Chrome. Read the counter with
**raw CDP over Node's global `WebSocket`** instead — no Playwright in the path:

    bash: ~/.local/share/mise/shims/node bin/counter.mjs

It fetches `/json/list`, picks the `/jobs/recommend` page, opens
`webSocketDebuggerUrl`, and sends one `Runtime.evaluate` for
`document.body.innerText`. Returns in ~1s **while a batch is still running**,
so the counter can be sampled mid-run without stopping anything.

This matters because the counter is the only authoritative submission count.
When the probe hung, the temptation was to conclude submissions weren't landing
and stop the batch to investigate — the counter had in fact gone 1907 -> 1931
(+24) and the pipeline was fine. Killing a healthy batch to chase a broken
probe cost ~190 jobs of progress. Sample the counter with raw CDP first.

## The option-leak was NOT fully fixed: a geography label + yes/no options (2026-09-21)

The `pressEsc` + last-visible-`[role=listbox]` scoping stopped dropdowns leaking
options page-wide, but it did NOT stop the wrong-data write. `llm.jsonl` proves
it still happened:

    {"q":"United States","a":"No","why":"Candidate address is in Canada, not US"}

A field whose extracted label was the bare string `United States` was answered
`"No"`. When the option set is `["Yes","No"]` that answer MATCHES and gets
selected — a country field set to "No" in a real submitted application. This is
writing wrong data, not merely failing to fill.

Two separate causes, both now fixed:

1. **The label-climb guard was length-based.** `l.length < 12` let
   `"United States"` (13) and `"Select a state"` (14) through, so the widget's
   own placeholder/value became the "question". The guard now also fires on
   `l === shown` and on a `^(select|choose|search|start typing|…)` prefix.

2. **Nothing cross-checked the label against the options.** Added a semantic
   mismatch guard just before the `infer()` call in `fillComboboxes()`: if the
   label is geography-shaped (`^(country|state|province|county|city|address|
   administrative area|united states|canada|select a state|zip|postal)\b`) AND
   every option is yes/no-shaped (≤4 opts), REFUSE and log an `unresolved` gap
   with `mismatch:'geo-label-yesno-options'`.

**Keep the guard narrow.** Do NOT generalise it to "refuse geography labels" —
`Country`/`City`/`State`/`Administrative Area` with real geography option lists
must still fill, and those fills were hard-won (the whole `City x40 / Country
x39 / Address Line 1 x23` gap session). Do NOT anchor the geography regex
loosely either: it must be `^`-anchored, or
`"Are you legally authorized to work in the United States?"` and
`"…require sponsorship…in the United States?"` get refused and every
work-auth question starts gapping. There is a passing 11-case table in the
2026-09-21 session covering exactly these boundaries — re-test them if you
touch either regex.

Also: `Administrative Area` is what Paylocity renames "State" to once Country
is set to Canada. It matched nothing in `bankValue()` and stayed permanently
empty; now mapped to `BANK.state`.

## `ONLY=` + a queue that excludes the job = a silent no-op that looks like a run (2026-09-21)

`ONLY=<id> QUEUE_FILE=offsite_batch.json` printed `offsite queue: 252` and
`processed=252 submitted=0` with **zero** `[n/252]` per-job lines, and appended
nothing to the ledger. It looked like a completed run. Nothing ran at all.

Cause: `offsite_batch.json` is built by *excluding* ids already in
`offsite3.jsonl`. Any job you want to RE-test is by definition already in the
ledger, so it is never in that file, so `ONLY=` filters the queue down to
nothing. `ONLY=` bypasses the ledger/`MAX_ATTEMPTS` check, but it cannot
conjure a job into a queue that omits it.

Always cut a one-line queue from the ledger record itself:

    const r = rows.filter(x => x.id === ID).pop();
    fs.writeFileSync('probe.json', JSON.stringify([{ id: r.id, txt: r.title }]));

Then `ONLY=<id> QUEUE_FILE=probe.json`. Verify the run really happened by
checking for a `[1/1]` line — `processed=` alone counts skips and is NOT
evidence that the target job was touched.

## The "interested" CTA selectors were a GLOBAL regression (2026-09-21)

Added for SmartRecruiters ("I'm interested"), the two entries
`'a:has-text("interested")', 'button:has-text("interested")'` were inserted at
**position 3** of the reveal list — ahead of every specific Apply variant except
"Apply Now". `:has-text()` is an **unanchored, case-insensitive substring**
match, so on *every* ATS any element whose text contains "interested" was
clicked first: "Not interested", "Interested in other openings?", talent-
community sign-ups. Each one burns the reveal attempt on a page that had a
perfectly good Apply button further down the list.

This is the most likely explanation for `myjobs.adp.com` going from 5/25
reveals pre-v4 to **0/20** after, and it silently taxed every other family too.

**Fix: they must stay LAST in the array.** SmartRecruiters still works, because
its page has no "apply"-texted control at all — the earlier selectors simply
miss and the loop reaches these anyway. There is no cost to being last and a
large cost to being early.

General rule for this list: the ordering comment at the top ("most specific,
least ambiguous first") is load-bearing. Any new selector matching a *generic
word* rather than an apply phrase goes at the END, or it hijacks every other
ATS. Host-scoping (`if (/smartrecruiters/.test(tab.url())) CTAS.unshift(...)`)
is the stronger version if a generic selector ever must run early.

## `scan()` deleted resume dropzones before it could count them (2026-09-21)

`if (e.offsetWidth <= 0 && e.offsetHeight <= 0) return;   // hidden/template clone`
ran BEFORE the `ty === 'file'` branch. A styled dropzone's real
`<input type=file>` is essentially always `display:none`/0x0 behind a visible
label, so it was dropped and the page reported `total === 0` -> `no-form-found`
-> an early `return` that never reaches `fillAll()`/`fillFiles()`. `fillFiles()`
queries `input[type=file]` with no `:visible` filter and would have handled it
fine; it was simply never reached.

This is why SmartRecruiters OneClick was 18/18 `no-form-found` on v4+: 48 of 53
records land already on `/oneclick-ui/company/<co>/publication/<uuid>` (past
"I'm interested"), where step one IS the dropzone and the rest of the
application is generated from the parsed resume. File inputs are now exempt
from the clone filter.

## CORRECTED: the Applied counter DOES count offsite submissions - it lags (2026-09-21, revised 2026-09-22)

**An earlier version of this entry claimed the counter is structurally blind to
offsite submissions. That was WRONG. Do not act on it.**

After a `SUBMITTED`, offsite3.mjs clicks JobRight's own **"Yes, I applied"**
button (line ~1734, sets `rec.marked = 1`), which registers the application on
JobRight. So offsite submissions DO increment `Applied`. Every offsite
`SUBMITTED` record carries `marked: 1`.

What actually happened: the counter read 1931 immediately after the first
offsite submission and looked frozen, so blindness was inferred. It later read
**1935** with no EASY APPLY pass running - i.e. the offsite marks landed, just
not instantly. The nav count lags behind the mark click.

**Practical rule:** the counter remains the authoritative total, for BOTH
passes. But it is eventually-consistent, so do NOT conclude a pass is broken
from a counter that has not moved yet. Cross-check the per-record evidence
first - `confirm`, `confirmText`, `proof: 1`, `marked: 1` - and re-read the
counter later. Sampling it mid-run is cheap (`bin/counter.mjs`, ~1s).

Note `bin/counter.mjs` needs a `/jobs/recommend` tab to exist; it returns
nothing after a tab cleanup closed that tab. Reopen with
`curl -s -X PUT "http://localhost:9222/json/new?https://jobright.ai/jobs/recommend"`.

## UKG/UltiPro: apply is a <ukg-button> custom element, and it leads to a login wall (2026-09-21)

SKILL.md said: "UltiPro (~14/run) - top document serves 0 inputs and no apply
control, and it is NOT a timing issue. Needs frame-level work." **Both halves
of that were wrong.** There IS an apply control, and the frames are irrelevant
(they are `about:blank` x2 and a 327KB Twitter widget).

The control, confirmed by live probe:

    <ukg-button class="ukg-color ukg-button-medium ukg-button-h">Apply now</ukg-button>

A **custom element** with `role = null` and its text in the **light DOM**.
Therefore `button:has-text()`, `a:has-text()` AND `[role=button]:has-text()`
all miss it, even though "Apply now" sits plainly in
`document.body.innerText`. Two guesses failed before the probe settled it:
`[role=button]` (role is null) and shadow DOM (text is light DOM). Added
`'ukg-button:has-text("Apply")'` to the reveal list - tag-scoped, so it cannot
hijack another ATS.

**The payoff is measurement, not submissions.** With the control clickable, all
tested UKG jobs reclassify `no-form-found` -> **`skip-login`** (2 of 2, third
concurrent). UKG's apply flow requires an account, so these ~32 jobs are a
legitimate hard skip under standing policy, not a fillable-form opportunity.
Do not keep trying to fill them; the win is that they leave the "unexplained
bug" pile and shrink the reachable denominator.

**Diagnosing this REQUIRED the `rec.ats` slice(0,300) fix.** The old records
truncated at exactly 100 chars, cutting `?opportunityId=`, and a probe against
the truncated URL loaded a job-less shell reporting
`inBodyText: false` - which would have "confirmed" the empty-page theory.
Always check `rec.ats.length` before trusting a probe against a stored URL.

**Probe over raw CDP, never `connectOverCDP`** - it hung here exactly as
documented above. Pattern: `PUT /json/new?<url>`, wait, open
`webSocketDebuggerUrl`, one `Runtime.evaluate`, then `/json/close/<id>`.

## The real root cause of `no-form-found`: two wrong assumptions (2026-09-21)

233 unique jobs sat at `no-form-found` — the single largest failure pool, bigger
than every other status combined. It was never one bug per ATS. It was two
assumptions, each wrong in a different place, confirmed by live probe:

**1. The reveal CTA list assumed the control is a `<button>` or an `<a>`.**
Every selector was `button:has-text()` / `a:has-text()`. Real controls:

| ATS | actual apply control |
|---|---|
| UKG/UltiPro | `<ukg-button>Apply now</ukg-button>` — custom element, `role=null` |
| iCIMS | `<span>Apply for this job online</span>` — inside a same-origin iframe |
| ADP | `<sdf-button role="button">Apply</sdf-button>` — custom element |

Fix: added `ukg-button:has-text("Apply")`, `[role=button]:has-text("Apply")`,
`input[type=button][value*="Apply" i]`, and **tag-agnostic** Playwright
`text="..."` selectors for long phrases. Keep `text=` to LONG phrases only and
at the END of the list — tag-agnostic matching on a short word like "Apply"
would hijack every decorative element (see the `interested` regression above).

**2. `scan()` assumed the light DOM.** Line ~311 used
`document.querySelectorAll('input,select,textarea')`, which does NOT pierce
shadow roots. Probe of SmartRecruiters OneClick:

    {"lightDOM_inputs":0,"shadowPiercing_inputs":14,"file_inputs":2,"shadowRoots":1815}

The whole form is web components. `scan()` saw 0, so `if (!s.total)` returned
`no-form-found` **before `fillAll()` ever ran** — and `fillAll()` uses Playwright
locators, which DO pierce open shadow DOM. The fill path was never broken;
the gate in front of it was blind. `scan()` now walks shadow roots (capped at
4000, with a visited set — a web-component ATS can carry ~2000 roots), and `pw`
is computed from the same collected list so a shadow-DOM login wall still trips
`skip-login`.

Result on 2 SmartRecruiters jobs: `no-form-found` -> **`READY 4/13`**.

**Corrected outcomes per family** (these replace the SKILL.md "where the yield
is" estimates, which were wrong about all four):
- **SmartRecruiters (~32)** — genuine unlock. Real form, now reachable.
- **UKG/UltiPro (~32)** — reveal works, lands on a login wall -> `skip-login`.
  Legitimate hard skip, NOT lost yield. SKILL.md's "needs frame-level work" was
  wrong: the frames are `about:blank` x2 and a Twitter widget.
- **iCIMS (~33)** — reveal works, lands on an account wall -> `skip-account`.
  Legitimate hard skip.
- **ADP (~28)** — reveal now works but yields a 1-input page
  (`too-sparse-refused 0/1`). Still open. Note the "two Apply elements,
  `.first()` picks the wrong one" note was a MISREADING: the only `<button>`
  match is an *invisible* `button#filter-apply-handler` (a job-filter control);
  the real CTA is `sdf-button`, which no selector could reach. There was never
  a choice between two valid buttons.

**A fix of mine that did nothing:** I first exempted file inputs from `scan()`'s
0x0 clone filter, on the theory that styled resume dropzones were being deleted.
Harmless, but NOT the cause — those file inputs were in shadow DOM and
unreachable either way. The probe (`lightDOM_inputs: 0`) refuted it. Get the
ground-truth element list before patching; two of my three guesses here were
wrong and the probe settled each in one shot.

## SmartRecruiters OneClick: four stacked blockers, and `fill()` is the wrong mechanism (2026-09-22)

Each layer was only visible after the previous one was fixed. Worth reading in
order before touching this family again.

1. **`scan()` blind to shadow DOM** -> form invisible -> `no-form-found`.
   (See the shadow-piercing entry above.) All SR inputs report `inShadow:true`.
2. **Next button is a custom element** -> `adv-no-next`. SR's control is
   `<oc-button type="primary">Next</oc-button>` / `<spl-button>`. Fixed via the
   `CE_BTN` list; confirmed by the trail changing to `next-disabled`.
3. **Next found but DISABLED** -> one required field never committed.
4. **`el.fill()` sets the value and the component throws it away.**

Layer 4 is the important one. `Confirm your email` (`confirm-email-input`,
`type=email`, `required`, 148x36, `visibility:visible`, in shadow DOM) was
filled successfully every pass -- `fillText`'s immediate read-back saw the value
present -- yet the final `scan()` reported it required-and-empty and SR kept
Next disabled. `spl-input` re-renders from its own state and blanks a
programmatic `.value`.

**Repetition does not help.** `fillAll` already calls `fillText` TWICE
(line ~983). Adding two more sweeps made four passes; the value was discarded
all four times. Two of my fixes here were wasted on the wrong theory:
- an immediate post-`fill()` read-back: fired **zero** times (the value IS
  present immediately; it is removed later)
- extra re-query sweeps: redundant with the existing second `fillText` call

**What actually worked:** `repairRequired()` at the end of `fillAll` -- real
keystrokes (`pressSequentially`) plus a `Tab` blur, on required-and-empty fields
whose answer is known, capped at 6 fields. Web components commit on real input
events and blur, not on a `.value` assignment.

    [repair] {"l":"Confirm your email*...","want":"liyuxiao2006@gmail.com","got":"liyuxiao2006@gmail.com"}

Result: `unresolved` emptied, the `next-disabled`/`adv-stuck0` trail vanished,
filled 5/14 -> 6/14, status `no-submit-btn` -> `submit-unconfirmed`.

**Two submit buttons on this family must NEVER be clicked**, both matched by
findSubmit's `/apply/`:
- `Apply With Indeed` -- a third-party handoff; leaves the ATS entirely.
- `Apply without resume` -- it DOES submit, but strips the resume `fillFiles()`
  just uploaded. A resume-less application is worse than an unsubmitted one.
Both are now excluded via `EXTERNAL_APPLY` / `DEGRADED_APPLY`, in the candidate
filter AND the post-match check. If a new SR variant stalls at
`no-submit-btn`, check whether the only remaining control is one of these
before widening the selector.

Still open: the job ends `submit-unconfirmed` with no proof screenshot, so it is
NOT established that SR submissions land. Verify with `confirm`/`confirmText`
on a small `SUBMIT=1` batch before trusting the family.

## Submit size guard: 5px was too loose (2026-09-22)

`if (!rec.sb || rec.sb.w < 5 || rec.sb.h < 5)` was tuned for the Lever 0x0
submit. It let a **65x11** fine-print "Submit" through on SmartRecruiters, which
then got clicked INSTEAD of advancing the wizard via the (by then enabled)
`oc-button` "Next" — because `findSubmit()` runs before the advance loop, so any
plausible-looking submit short-circuits the wizard walk.

Raised to `w < 24 || h < 14`. Every real submit CTA observed across these ATSs
is 28-48px tall (SR's own primaries are 40px; "Apply without resume" was
352x40). Failing honestly as `submit-btn-not-visible` is strictly better than
clicking fine print and reporting `submit-unconfirmed`.

**SmartRecruiters is still NOT proven to submit.** Best state reached: form
revealed, all required fields committed (`unresolved: []`), wizard unblocked,
but the run ends `submit-unconfirmed` with no proof screenshot. The remaining
work is walking OneClick's multi-step wizard to its real terminal Submit, which
lives on a later step than the one `findSubmit` inspects. Do not count this
family as working without `confirmText`.

## My own diagnostic lied: `ctas` did not record render state (2026-09-22)

The `rec.frames[].ctas` list added earlier this session collected every
matching element **regardless of whether it was rendered**. On Google Careers
and jobs.merck.com it reported:

    ctas: ["Learn more<a>","Agree<button>","No thanks<button>", ...]
    ctas: ["Read Full Privacy Message<button>","Decline<button>","Accept Cookies<button>"]

which reads exactly like a live cookie-consent overlay blocking the page. It is
not. A direct probe shows those buttons are **`rects:0 w:0 h:0`** - dormant DOM.
Clicking "Agree" changes nothing, and the page has `applyCount:0, inputs:0`
either way.

**Cost: three wrong fixes** chasing a consent banner that never existed
(reordering `dismissBanners`, then making it iframe-aware, then removing its
`break`). The iframe-aware version is kept because it is genuinely more correct
for real overlays, but it fixed nothing here.

This is the SAME trap the captcha entry in this file already warns about -
"rendered-size alone is NOT the test", inverted: **element existence is not
evidence of rendering.** I built a new instrument and reproduced the exact
mistake the file warned about.

`ctas` now suffixes non-rendered entries with `~` and adds a `visCtas` count.
**When reading a diagnostic, check whether the instrument records visibility
before concluding anything from the presence of an element.**

**What Google Careers actually is:** ~4 jobs whose pages render the Careers nav
shell with no job content, no apply control and zero inputs - expired or
unavailable postings, not a bug on our side. `jobs.merck.com` looks the same.
Do not spend more cycles on these; they are correctly unfillable. The honest
classification would be "expired", not `no-form-found`.

## The multistep-wizard family was never walked (2026-09-22)

19 jobs sat at `skip-multistep-wizard`, **every one of them with >=8 fields
already filled** - the expensive work done, then discarded at the last step.

**Cause:** `findSubmit()`'s FIRST branch filters `NAV_NOT_SUBMIT`, but its
SECOND branch (`button[type=submit]`) does not. A wizard whose "Next" is
`type=submit` therefore came back as a truthy `sb`, and the advance loop below
only runs `if (!sb)` - so the tested wizard-walking code was never reached and
the job was abandoned. Fix: if the found submit matches `NAV_NOT_SUBMIT`, null
it (logging `sb-was-next:<text>` to `WIZ_TRAIL`) so the advance loop runs.

**The skip branch also recorded nothing** - no `req`/`btns`/`navErrs` - which is
why all 38 historical wizard records were undiagnosable. Same "status records
nothing" flaw as `no-form-found`. Now instrumented.

Effect on 5 test jobs, one pass: every one advanced, and one cleared a whole
wizard step (`0:14/16` -> `1:17/28`; cai.io went `0:14/18` -> `1:3/5`).
cai.io 14->16/18, kwiktrip 17->23/28, Cisco 11->12/17.

**Answers the ATSs then named themselves** (all added to `learned.json`):
- `Prefecture*` = province dropdown, Canadian options. -> `BANK.state`
  (bankValue rule, alongside `administrative area`).
- "Have you ever been employed by a CAI company?" -> No. The `NO` regex covers
  "previously work|currently employed by" but NOT "ever been employed by".
- `Education Type*` (No Degree/High School/Associates/**Bachelors**/...) ->
  "Bachelors Degree".
- `Degree Achieved*` (Yes/No/**In Progress**) -> "In Progress". Graduating 2028,
  so "Yes" would be false.
- `Are you willing to travel?*` (Yes: 1-2 times per year / ... / No) -> "Yes";
  fuzzyOpt maps the bare word onto the qualified option.
- "Have you ever been issued a Cisco Employee ID" -> No.

**My own earlier gap-fix was wrong:** I had set
`"how did you hear" -> "Online Job Board"`, which is not an option on most of
these selects (Cisco offers Cisco Careers Site / LinkedIn / Job Posting Site /
Social), so fuzzyOpt could never match and every such select gapped. Changed to
"LinkedIn", which appears in nearly every list. **When adding a learned answer,
check it against a real option list** - an answer that matches no option is
indistinguishable from having no answer.

**Two blockers that should stay gapped:**
- cai.io "Please select your current US Status" - options are Citizen / E3 /
  F-1 OPT / F-1 CPT / H-1B / Naturalized. A Canadian student in Canada is NONE
  of these. No truthful option exists; work_auth is on `never_infer`. Correct
  to gap.
- cai.io `State*` with US-only states against an Ontario address. Same
  unfixable as Paylocity.

**Still broken - the option leak is NOT fully fixed.** Cisco shows
`q:"My information Country or Region * Please Select Afghanistan..."` with
`opts:["Send SMS","Send Emails","Send WhatsApp"]` - a country field carrying
another widget's options. My geo-guard did not fire because `GEO_Q` is
`^`-anchored and this label starts with "My information", and `YESNO_OPTS`
did not match "Send SMS". It gapped rather than mis-wrote, so no wrong data,
but the country field stays empty and Cisco stays blocked.

## 2026-09-24 (late night) - slowness and invisible controls

- **Combobox re-commit ran on every pass.** fillText re-commits a filled combo
  (the Ashby location fix), but it did so in text1, text2 and both sweeps, and
  again after the LLM pass. On Rippling that was ~100s of a 240s budget, and
  7/7 Rippling jobs timed out in `fill`. Each combo is now marked
  `data-ja-done` on first handling, and a re-commit is skipped if the shown
  value already contains the answer.
- **"Choose not to disclose" read as a placeholder.** fillComboboxes' empty
  test was `^(select|choose|...)`, so an answered EEO picker was redone every
  pass. Answers that merely start like a placeholder (disclos/declin/prefer
  not) are now non-empty.
- **`[slowfield]` includes the stages after text1.** The last text field's
  interval absorbs radios/combos/files. Use `[slowcombo]` and the `[time]`
  stage map, not one giant slowfield line.
- **ARIA radios: try role=radio first.** The #id/check/label chain spent
  3 x 2.5s failing before the click that works (radios 20s -> 5s).
- **Nameless radios (Gem).** Gem's Yes/No radios have ids but no `name`;
  fillRadios keyed on name and saw none of them. Groups now key by name, or by
  the nearest ancestor holding 2+ radios. All group addressing goes through
  `data-ja-grp`.
- **Upload captions.** "Click to upload or drag and drop here" (Gem) and
  "Upload from PC" / "Upload a file type of DOC..." (Phenom/Cisco) must count
  as generic captions and be stripped before the heading climb, or the resume
  is refused as not-a-doc-we-have.
- **Leaked tabs that redirected off jr_id** (Taleo, iCIMS login, SAP) were
  never reaped. Chrome's main process hit 93% CPU at load average 25. The
  reaper now also closes earlier jobs' OWN sets.
- **Fast skips from applyLink.** __NEXT_DATA__ applyLink is read on every
  job. Workday, Taleo careersection and myjobs.adp.com are skipped before the
  autofill click (Workday was 31% of outcomes at ~20s each).
- **Taleo careersection and ADP MyJobs = skip-account.** Taleo needs
  candidate sign-in; the ADP MyJobs job page renders only "Sign in".
  workforcenow.adp.com is a different product and is NOT skipped.
- **Retry queues must exclude possibly-submitted jobs.** Only retry
  submit-unconfirmed when `diag.errs` is non-empty (the ATS refused). Ashby
  and Lever confirmations can arrive late, so a blind retry risks a
  duplicate application.
- **fuzzyOpt raw substring = wrong data.** `w.includes(nkey(o))` made
  "ontario" match the option "AR". Whole-word containment only (offsite3 and
  apply3).
- **YES/NO fallback must be bare.** `find(/^yes/i)` picked "Yes- I'm in San
  Francisco Bay Area and willing to work hybrid..." for a Toronto candidate.
  Qualified options carry their own claims; they go to the LLM now.
- **LLM answer key mismatch.** Gaps are logged with q sliced to 140 chars,
  but lookups used the full text (norm slices at 180), so every radio
  question over 140 chars lost its LLM answer. Use `llmGet()` (prefix
  tolerant, both keys >= 40 chars).
- **The extension writes wrong values we then trust as "already filled":**
  last name into "Personal Pronouns", a US state next to Country=Canada.
  Scrubbed in fillText/fillSelects.
- **restart.sh closes every tab except /jobs/recommend**, including the tabs
  of a non-shard worker (retry queue). Its current job ends err:* (not an
  attempt), so this costs little.
