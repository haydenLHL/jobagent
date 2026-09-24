#!/bin/zsh
export PATH="$HOME/.local/share/mise/shims:$PATH"
cd "$HOME/.jobagent"
while pgrep -f "node easyapply.mjs" >/dev/null; do sleep 30; done
echo "=== easyapply round2 finished; starting autofill path ==="
KEEP=2 node reap.mjs
SUBMIT=1 node autofill.mjs
echo "=== AUTOFILL DONE ==="
