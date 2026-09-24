#!/bin/zsh
export PATH="$HOME/.local/share/mise/shims:$PATH"
cd "$HOME/.jobagent"
echo "=== PASS 1 START ==="
SUBMIT=1 node run2.mjs
echo "=== PASS 1 DONE ==="
KEEP=2 node reap.mjs
echo "=== PASS 2 START ==="
SUBMIT=1 node pass2.mjs
echo "=== PASS 2 DONE ==="
