#!/bin/bash
# Wraps offsite3.mjs in a restart loop. connectOverCDP's Browser object can get
# permanently marked "closed" in-process after any tab dies unexpectedly, even
# though the real Chrome process and CDP endpoint are fine (confirmed live:
# /json/version and /json/list kept responding normally throughout). In-process
# reconnect (chromium.connectOverCDP called again) did not reliably clear this -
# a full process restart does, because it's a fresh OS process with no stale
# Playwright-side Browser object at all. The ledger (offsite3.jsonl) already
# dedupes by job id, so restarting mid-batch is safe and only ever costs the
# one job that was in flight when the crash happened.
MAX_RESTARTS=${MAX_RESTARTS:-30}
for i in $(seq 1 "$MAX_RESTARTS"); do
  echo "=== attempt $i/$MAX_RESTARTS ==="
  ~/.local/share/mise/shims/node offsite3.mjs
  code=$?
  echo "=== node exited with code $code ==="
  if [ "$code" -eq 0 ]; then
    echo "=== queue fully drained, done ==="
    break
  fi
  sleep 3
done
