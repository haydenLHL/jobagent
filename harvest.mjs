import { chromium } from 'playwright-core';
import fs from 'fs';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0]; const p=await c.newPage();
try{
 await p.goto('https://jobright.ai/jobs/recommend',{waitUntil:'domcontentloaded',timeout:45000});
 await p.waitForTimeout(8000);
 await p.evaluate(()=>{const t=document.getElementById('___reactour'); if(t)t.remove();});
 const seen=new Map();
 let stale=0;
 for(let round=0; round<40 && stale<4; round++){
   const found=await p.evaluate(()=>{
     const o=[];
     document.querySelectorAll('a[href*="/jobs/info/"]').forEach(a=>{
       const m=(a.getAttribute('href')||'').match(/\/jobs\/info\/([a-f0-9]+)/i);
       if(m){ const card=a.closest('[class*=card],[class*=item],li,div'); 
              o.push({id:m[1], txt:((card?.innerText)||a.innerText||'').replace(/\s+/g,' ').trim().slice(0,110)}); }
     });
     return o;
   });
   const before=seen.size;
   found.forEach(f=>{ if(!seen.has(f.id)||seen.get(f.id).length<f.txt.length) seen.set(f.id,f.txt); });
   stale = (seen.size===before) ? stale+1 : 0;
   await p.mouse.wheel(0,6000); await p.waitForTimeout(1800);
   if(round%8===7) console.log(`  round ${round+1}: ${seen.size} unique jobs`);
 }
 const arr=[...seen.entries()].map(([id,txt])=>({id,txt}));
 fs.writeFileSync('jobs.json', JSON.stringify(arr,null,1));
 console.log(`\nTOTAL unique jobs harvested: ${arr.length}`);
 arr.slice(0,10).forEach((j,i)=>console.log(` ${i+1}. ${j.id}  ${j.txt.slice(0,78)}`));
} finally { await p.close(); await b.close(); }
