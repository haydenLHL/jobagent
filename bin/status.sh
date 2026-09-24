#!/bin/bash
# Tally the jobapply ledgers (latest record per job id) plus the backlog.
# The JobRight Applied counter is the real number; this is only a breakdown
# of what the scripts think happened.
cd "$HOME/.jobagent" || exit 1
~/.local/share/mise/shims/node bin/funnel.mjs "$@"
echo
echo "gaps.jsonl:   $(wc -l < gaps.jsonl 2>/dev/null | tr -d ' ') lines (append-only)"
echo "learned.json: $(grep -c '":' learned.json 2>/dev/null) keys"
