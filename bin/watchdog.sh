#!/bin/bash
# Keeps N offsite3 shard workers alive. A shard is restarted when its process
# is gone without a "processed=" line (crash / "unrecoverable" exit), or when
# its log has not grown for STALL seconds (hung: JOB_TIMEOUT failed to fire,
# CDP handshake wedged, b.close() hang). Restarting is safe: offsite3 dedupes
# against offsite3.jsonl, so a restarted shard skips what it already did.
# Usage: nohup bash bin/watchdog.sh 4 > watchdog.log 2>&1 &
cd "$HOME/.jobagent" || exit 1
N=${1:-4}
STALL=${STALL:-540}          # > JOB_TIMEOUT (420s) + margin
JT=${JOB_TIMEOUT:-420000}
NODE="$HOME/.local/share/mise/shims/node"
log() { echo "$(date +%H:%M:%S) $*"; }

pid_of() { cat "shard$1.pid" 2>/dev/null; }
alive() { local p; p=$(pid_of "$1"); [ -n "$p" ] && ps -p "$p" -o command= 2>/dev/null | grep -q offsite3.mjs; }

start() {
  local k=$1
  # CDP must be up and have at least one tab, or connectOverCDP breaks.
  curl -s --max-time 5 localhost:9222/json/version >/dev/null || { log "CDP down, starting chrome"; bash bin/chrome.sh >/dev/null 2>&1; sleep 5; }
  # Only when there is no tab at all (the handshake needs one); an unconditional
  # PUT left one extra about:blank per restart.
  curl -s --max-time 5 localhost:9222/json/list | grep -q '"type": "page"' || curl -s -X PUT "http://localhost:9222/json/new?about:blank" >/dev/null 2>&1
  echo "--- restart $(date) ---" >> "shard$k.log"
  QUEUE_FILE="shard$k.json" JOB_TIMEOUT=$JT SUBMIT=1 nohup "$NODE" offsite3.mjs >> "shard$k.log" 2>&1 &
  echo $! > "shard$k.pid"
  log "shard$k started pid $!"
}

# adopt already-running workers (launched before the watchdog) by queue file
for k in $(seq 0 $((N-1))); do
  if ! alive "$k"; then
    p=$(ps -eo pid,command | grep "[n]ode offsite3.mjs" | awk '{print $1}' | while read -r q; do
      ps eww -p "$q" 2>/dev/null | grep -q "QUEUE_FILE=shard$k.json" && echo "$q"; done | head -1)
    [ -n "$p" ] && echo "$p" > "shard$k.pid" && log "shard$k adopted pid $p"
  fi
done

declare -a last_size last_change
while true; do
  now=$(date +%s); all_done=1
  for k in $(seq 0 $((N-1))); do
    if tail -3 "shard$k.log" 2>/dev/null | grep -q "processed=" && ! alive "$k"; then continue; fi
    all_done=0
    sz=$(wc -c < "shard$k.log" 2>/dev/null || echo 0)
    if [ "${last_size[$k]}" != "$sz" ]; then
      [ -n "${last_size[$k]}" ] && tail -1 "shard$k.log" | grep -E "^\[[0-9]+/" | sed "s/^/$(date +%H:%M:%S) shard$k /"
      last_size[$k]=$sz; last_change[$k]=$now
    fi
    if ! alive "$k"; then
      log "shard$k DIED ($(tail -1 "shard$k.log" | cut -c1-80)) -> restarting"; start "$k"; last_change[$k]=$now
    elif [ $((now - ${last_change[$k]:-$now})) -gt "$STALL" ]; then
      log "shard$k HUNG ${STALL}s no output -> killing pid $(pid_of "$k")"
      kill "$(pid_of "$k")" 2>/dev/null; sleep 3; kill -9 "$(pid_of "$k")" 2>/dev/null
      start "$k"; last_change[$k]=$now
    fi
  done
  [ "$all_done" = 1 ] && { log "ALL SHARDS DONE"; exit 0; }
  sleep 20
done
