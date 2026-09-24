import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const ps=c.pages();
console.log('open tabs:', ps.length);
const g={};
ps.forEach(p=>{ let h='?'; try{h=new URL(p.url()).host}catch{}; g[h]=(g[h]||0)+1; });
Object.entries(g).sort((a,x)=>x[1]-a[1]).forEach(([h,n])=>console.log(`  ${String(n).padStart(3)}  ${h}`));
await b.close();
