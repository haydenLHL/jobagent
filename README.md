# jobagent

JobRight auto-apply scripts plus the `jobapply` Claude Code skill (`skill/`).

## Fresh machine

1. `git clone git@github.com:liyuxiao2/jobagent.git ~/.jobagent && cd ~/.jobagent && npm install`
2. `mkdir -p ~/.claude/skills && ln -s ~/.jobagent/skill ~/.claude/skills/jobapply`
3. Copy personal data by hand (not committed): `answers.json`, `learned.json`,
   `resume.pdf`, `transcript.pdf`, `applied3.jsonl`, `offsite3.jsonl`.
   Without the ledgers, jobs already applied to get re-submitted.
   Fix the `resume`/`transcript` paths in `answers.json` if `$HOME` differs.
4. Node via mise (`~/.local/share/mise/shims/node`).
5. `bash bin/chrome.sh`, then in that Chrome: install the JobRight extension and log in.
6. In Claude Code: `/jobapply`.

## Windows + Opera (this fork)

Your personal details live only in `answers.json` (read by `profile.mjs`); nothing
personal is hardcoded in the scripts. `answers.json` and `resume.pdf` are gitignored,
so copy them into the repo folder by hand.

1. Install Node.js LTS, Git, and Claude Code (native installer, so `claude.exe`
   exists) and log in to Claude Code once. The agent uses it to answer unusual
   form questions.
2. `git clone -b claude/amazing-tesla-gwy6j2 https://github.com/haydenLHL/jobagent.git`,
   then `cd jobagent` and `npm install`.
3. Put `answers.json` and `resume.pdf` in that folder. Fill in the `null`s in
   `answers.json` you want to share (city, address, postal code, GPA, pay).
4. Start Opera for the agent: `powershell -ExecutionPolicy Bypass -File bin\opera.ps1`.
   The first time, in the Opera window that opens, install the JobRight extension and
   log in to JobRight. It uses its own `opera-profile` folder, separate from your
   everyday Opera, so both are needed once.
5. In PowerShell, from the repo folder:
   ```
   $env:CLAUDE_BIN = (Get-Command claude).Source
   node harvest_recommend.mjs                 # -> jr_jobs.json
   node scope.mjs                             # Canada only -> jr_jobs_target.json
   $env:QUEUE_FILE = 'jr_jobs_target.json'
   node apply3.mjs                            # dry run: fills forms, submits nothing
   $env:SUBMIT = '1'; node apply3.mjs         # real EASY APPLY pass
   ```
   Then build `offsite_batch.json` and run `offsite3.mjs` with `LIMIT=5` first,
   as described in `skill/SKILL.md`. Never run the two passes at once.
