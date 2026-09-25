#!/bin/zsh
export PATH="$HOME/.local/share/mise/shims:$PATH"
cd "$HOME/.jobagent"
while true; do
  n=$(curl -s --max-time 3 http://127.0.0.1:9222/json/list 2>/dev/null | grep -c '"type": "page"')
  if [ "${n:-0}" -gt 6 ]; then
    KEEP=4 node reap.mjs 2>&1 | tail -1
  fi
  sleep 45
done
