#!/bin/bash
# Restart the automation Chrome AND all workers (shards via restart.sh, plus the
# retry worker if retry.pid/RETRY_QUEUE exist). Chrome bloats to 14-20 GB of
# renderers within ~1h of 5 workers and drags every CDP call (2026-09-24).
cd "$HOME/.jobagent" || exit 1
pkill -f "bin/watchdog.sh" 2>/dev/null || true
[ -f retry.pid ] && kill "$(cat retry.pid)" 2>/dev/null || true
for k in 0 1 2 3; do [ -f "shard$k.pid" ] && kill "$(cat "shard$k.pid")" 2>/dev/null || true; done
sleep 4
for p in $(pgrep -f "node offsite3.mjs"); do ps eww -p "$p" 2>/dev/null | grep -q "QUEUE_FILE=\(shard\|retry\)" && kill -9 "$p" 2>/dev/null; done
CP=$(ps -eo pid,command | grep "[G]oogle Chrome --remote-debugging-port=9222" | awk '{print $1}' | head -1)
[ -n "$CP" ] && kill "$CP" 2>/dev/null
for i in $(seq 1 15); do ps -p "$CP" >/dev/null 2>&1 || break; sleep 1; done
bash bin/chrome.sh >/dev/null 2>&1; sleep 8
bash bin/restart.sh 4
if [ -n "$RETRY_QUEUE" ]; then
  QUEUE_FILE="$RETRY_QUEUE" JOB_TIMEOUT=300000 SUBMIT=1 SKIP_SINCE="${RETRY_SINCE:-$SKIP_SINCE}" nohup "$HOME/.local/share/mise/shims/node" offsite3.mjs >> "${RETRY_QUEUE%.json}.log" 2>&1 &
  echo $! > retry.pid; echo "retry worker $!"
fi
