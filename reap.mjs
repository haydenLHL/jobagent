import { chromium } from 'playwright-core';
const KEEP=Number(process.env.KEEP||4);
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const ps=c.pages();
if(ps.length<=KEEP+1){ console.log(`tabs=${ps.length}, nothing to reap`); await b.close(); process.exit(0); }
// keep the newest KEEP tabs (the running job's), plus one jobright anchor tab
const keep=new Set(ps.slice(-KEEP));
const anchor=ps.find(p=>/jobright\.ai\/jobs\/recommend/.test(p.url()));
if(anchor) keep.add(anchor);
let closed=0;
for(const p of ps){
  if(keep.has(p)) continue;
  try{ await p.close({runBeforeUnload:false}); closed++; }catch{}
}
console.log(`reaped ${closed}; tabs ${ps.length} -> ${c.pages().length}`);
await b.close();
