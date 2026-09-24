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
