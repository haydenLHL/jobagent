# Questions to leave unanswered — and why

A gap logged to `gaps.jsonl` is a *correct* outcome for everything below. None
of these is a missing rule or a missing fact to go add; each one is a question
where no truthful answer is derivable from `answers.json`. Re-deriving this list
costs a pass every time it is forgotten, so it lives here.

The governing policy is in `answers.json`:
- `policy.never_infer` — work_auth, sponsorship, citizenship, clearance,
  degree, school, grad_year, gpa, gender, race, hispanic, veteran, disability.
- `policy.never_agreeable` — years_of_experience, proficiency_level,
  certification_held, enrolled_in_program, prior_employment_claim,
  terminated_for_cause, disciplinary_action, language_fluency. These must gap
  even when phrased as an agreeable yes/no.
- `policy.agreeable_allowlist` is a **closed** list. A question not on it never
  receives a default answer no matter how harmless it sounds.

## Regulatory / legal disclosures

- **"Are you named in any pending investment-related civil action…"**
  (FINRA U4-style, seen on Strategic Operations Analyst). A regulatory
  disclosure, not a preference.
  Note the shape: it *leads* with the question and only trails with "If no or
  not applicable…", so the conditional-followup rule does not fire. **Do not
  widen that rule to catch this.**
- **ITAR / "U.S. Person status"** — same class.
- **"Do you currently have an active immigration case (ex H-1B extension,
  green card)"** — adjacent to work_auth/citizenship. Usually optional; leave
  blank.

## Self-assessment and capability claims

- **"What is your proficiency with Microsoft Excel / Microsoft 365"**
- **"Before applying, how familiar are you with <company>?"**
- **"Have you participated in any of the following mathematics competitions?"**
  — a factual claim about the candidate with no bank fact behind it.

## Unanswerable by construction

- **`State` / `Province` selects whose options are US-only**, against an
  Ontario address. Cai.io, Paylocity, Platforms & Business Consulting, Site
  Reliability, AI/ML Research all hit this. Ontario is simply not offered.
  `infer()` takes Ontario if present, else an explicit escape hatch (Outside
  the US / Non-US / Not Applicable / Other) if the form has one, else gaps.
  **It must never invent a US state.**
- **cai.io "Please select your current US Status"** — Citizen / E3 / F-1 OPT /
  F-1 CPT / H-1B / Naturalized. A Canadian student in Canada is none of these.
- **Datadog "Which area is your first / second / third choice?"** — a genuine
  preference among nine engineering domains. Not inferable, and guessing
  assigns a career preference on the candidate's behalf.
- **Multi-select office/product preference** (Palantir "Select 1–3",
  "Pick 1–2").
- **The mangled label `Country Country *Phone`** — a phone-country combobox
  whose label extraction is broken. Fix the label before answering it.
- **Any language not listed in `answers.json.languages`.** The
  `_languages_note` is explicit: answer null; do **not** assert the candidate
  does not speak it. ("What is your fluency level in Korean" → blank.)
- **Documents that do not exist on disk** — research supplement, writing
  sample, portfolio, cover letter, references. Only `resume.pdf` and
  `transcript.pdf` exist, and attaching the resume to one of these fields
  sends the wrong document, which is worse than leaving it empty.

## Needs a new bank fact, not a rule

- **"Start month/year of university and end month/year of university."**
  `answers.json` has `education[0].start_year = 2024` and
  `end_date = 2028-04-30`, but **no start month**, so the answer cannot be
  composed without inventing September. Add `university_start_month` to
  `answers.json` AND `offsite3.mjs`'s `BANK` (the dual-write rule) before
  answering this one.

## When adding to `learned.json`, two rules

1. **Check the answer against a real option list.** An answer that matches no
   option is indistinguishable from having no answer — `"how did you hear" ->
   "Online Job Board"` matched nothing on Cisco and gapped every such select.
2. **Country-qualify anything about entitlement or status.** `LEARNED` is
   consulted BEFORE the WORK_AUTH rule, so a broad key like
   `"legally entitled to work"` would assert "Yes" on *"…to work in the United
   States"*, where `answers.json` has `work_auth: false`. Use
   `"legally entitled to work in canada"`.
