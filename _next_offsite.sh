#!/bin/bash
cd "$HOME/.jobagent"
while pgrep -f "[n]ode apply3.mjs" >/dev/null; do sleep 15; done
NODE="$HOME/.local/share/mise/shims/node"
$NODE -e '
const fs=require("fs");
const rd=f=>fs.existsSync(f)?fs.readFileSync(f,"utf8").trim().split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean):[];
const target=new Set(JSON.parse(fs.readFileSync("jr_new_0924.json","utf8")).map(j=>j.id));
const done=new Set(rd("offsite3.jsonl").map(r=>r.id));
const seen=new Set(); const d=[];
for(const r of rd("applied3.jsonl")) if(r.status==="offsite-deferred"&&target.has(r.id)&&!done.has(r.id)&&!seen.has(r.id)){seen.add(r.id);d.push({id:r.id,txt:r.title});}
fs.writeFileSync("offsite_new_0924.json",JSON.stringify(d));
for(let k=0;k<4;k++) fs.writeFileSync(`shard${k}.json`,JSON.stringify(d.filter((_,i)=>i%4===k)));
console.log("offsite batch",d.length);'
JOB_TIMEOUT=60000 bash bin/restart.sh 4
