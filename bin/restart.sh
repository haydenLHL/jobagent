#!/bin/bash
# Restart the offsite3 shard workers onto the current code. Every step is
# failure-tolerant: an earlier inline version chained with a kill that could
# fail, aborted, and left ZERO workers running (2026-09-24).
# Usage: bash bin/restart.sh [N]   (env passes through: JOB_TIMEOUT, STALL, ...)
cd "$HOME/.jobagent" || exit 1
N=${1:-4}
pkill -f "bin/watchdog.sh" 2>/dev/null || true
for k in $(seq 0 $((N-1))); do [ -f "shard$k.pid" ] && kill "$(cat "shard$k.pid")" 2>/dev/null || true; done
sleep 3
for p in $(ps -eo pid,command | grep "[n]ode offsite3.mjs" | grep -v ONLY= | awk '{print $1}'); do
  ps eww -p "$p" 2>/dev/null | grep -q "QUEUE_FILE=shard" && kill -9 "$p" 2>/dev/null || true
done
curl -s localhost:9222/json/list | "$HOME/.local/share/mise/shims/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",async()=>{for(const x of JSON.parse(s).filter(x=>x.type==="page")) if(!/jobs\/recommend/.test(x.url)) await fetch("http://localhost:9222/json/close/"+x.id).catch(()=>{});})' || true
curl -s -X PUT "http://localhost:9222/json/new?about:blank" >/dev/null || true
export JOB_TIMEOUT=${JOB_TIMEOUT:-240000} STALL=${STALL:-660}
nohup bash bin/watchdog.sh "$N" >> watchdog.log 2>&1 &
sleep 6
echo "workers: $(ps -eo command | grep -c '[n]ode offsite3.mjs')"
