#!/bin/bash
# Idempotently bring up the real Chrome on CDP 9222 with the jobagent profile.
# Must launch the binary directly - `open -na` breaks CDP download behavior.
if curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "CDP already up on 9222"
  curl -s http://127.0.0.1:9222/json/version | head -c 200; echo
  exit 0
fi
nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.jobagent/chrome-profile" \
  --no-first-run --no-default-browser-check \
  >/dev/null 2>&1 &
for i in $(seq 1 20); do
  sleep 1
  if curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    echo "CDP up on 9222"; exit 0
  fi
done
echo "FAILED to bring up CDP on 9222" >&2
exit 1
