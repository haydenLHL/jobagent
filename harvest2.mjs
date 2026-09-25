import { chromium } from 'playwright-core';
import fs from 'fs';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
try{
 await p.goto('https://jobright.ai/jobs/recommend',{waitUntil:'domcontentloaded',timeout:45000});
 await p.waitForTimeout(8000);
 await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
 // find the real scrollable container (not window)
 const info=await p.evaluate(()=>{
   const els=[...document.querySelectorAll('div,main,section')].filter(e=>e.scrollHeight>e.clientHeight+120 && e.clientHeight>300);
   return els.slice(0,5).map(e=>({cls:(typeof e.className==='string'?e.className:'').slice(0,45),sh:e.scrollHeight,ch:e.clientHeight}));
 });
 console.log('scroll containers:', JSON.stringify(info));
 const seen=new Map(); let stale=0;
 for(let r=0;r<120 && stale<8;r++){
   const found=await p.evaluate(()=>{
     const o=[];
     document.querySelectorAll('a[href*="/jobs/info/"]').forEach(a=>{
       const m=(a.getAttribute('href')||'').match(/\/jobs\/info\/([a-f0-9]+)/i);
       if(m){const card=a.closest('[class*=card],[class*=item],li');o.push({id:m[1],txt:((card?.innerText)||a.innerText||'').replace(/\s+/g,' ').trim().slice(0,100)});}
     });
     return o;
   });
   const before=seen.size;
   found.forEach(f=>{if(!seen.has(f.id)||seen.get(f.id).length<f.txt.length)seen.set(f.id,f.txt);});
   stale = seen.size===before ? stale+1 : 0;
   // scroll every candidate container AND window
   await p.evaluate(()=>{
     window.scrollBy(0,5000);
     [...document.querySelectorAll('div,main,section')].filter(e=>e.scrollHeight>e.clientHeight+120&&e.clientHeight>300)
       .forEach(e=>{e.scrollTop=e.scrollTop+5000;});
   });
   await p.keyboard.press('End').catch(()=>{});
   await p.waitForTimeout(1600);
   if(r%10===9) console.log(`  round ${r+1}: ${seen.size} unique`);
 }
 const arr=[...seen.entries()].map(([id,txt])=>({id,txt}));
 fs.writeFileSync('jobs.json',JSON.stringify(arr,null,1));
 console.log(`TOTAL: ${arr.length} unique jobs`);
} finally { await p.close(); await b.close(); }
