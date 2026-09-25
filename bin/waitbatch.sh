#!/bin/bash
# Exit when N more driver result lines land, or the driver process dies.
cd "$HOME/.jobagent"; N=${1:-15}
n0=$(grep -c '^\S* \[' inorder.log)
while :; do
  n=$(grep -c '^\S* \[' inorder.log)
  [ $n -ge $((n0+N)) ] && { echo "BATCH $n"; break; }
  grep -q processed= inorder.log && { echo "DONE"; break; }
  ps -eo command | grep -q "[n]ode inorder.mjs" || { echo "DIED at $n"; break; }
  sleep 30
done
