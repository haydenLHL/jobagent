#!/bin/bash
# Compact review of this session's non-trivial outcomes since a timestamp.
cd "$HOME/.jobagent"; SINCE=${1:-2026-09-25T05:40}
tail -n ${2:-15} inorder.log
~/.local/share/mise/shims/node -e '
const fs=require("fs"),S=process.argv[1];
const HARD=/^(SUBMITTED|ALREADY-APPLIED|skip-workday|skip-login|skip-account|skip-listed|skip-closed)$/;
const rs=fs.readFileSync("offsite3.jsonl","utf8").trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(r=>r&&r.ts>S);
for(const r of rs.slice(-20)) if(!HARD.test(r.status)) console.log("·",r.id.slice(-6),r.status,(r.filled??"-")+"/"+(r.total??"-"),(r.ats||"").split("/")[2],"af="+JSON.stringify(r.extAF||null).slice(0,90),"| U="+JSON.stringify((r.unresolved||[]).map(u=>(u.q||"").slice(0,50)+(u.options&&u.options.length?"["+u.options.slice(0,3).join("/").slice(0,40)+"]":""))).slice(0,260),"| E="+JSON.stringify(r.diag?.errs?.slice(0,1)||r.navErrs?.slice(0,1)||r.sparse||r.capWhy||"").slice(0,160));
' "$SINCE"
