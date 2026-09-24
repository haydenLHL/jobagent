import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0]; const p=await c.newPage();
try{
 await p.goto('https://jobright.ai/jobs/info/6aa4924f8275e3a211760d71',{waitUntil:'domcontentloaded',timeout:45000});
 await p.waitForTimeout(7000);
 console.log('url:', p.url().slice(0,90));
 console.log('tour present:', await p.locator('#___reactour').count());
 const st=await p.evaluate(()=>{
   const el=Array.from(document.querySelectorAll('button')).find(x=>/AUTOFILL/i.test(x.innerText||''));
   if(!el) return {found:false, btns:Array.from(document.querySelectorAll('button')).map(x=>(x.innerText||'').replace(/\s+/g,' ').trim()).filter(t=>t&&t.length<28).slice(0,12)};
   const r=el.getBoundingClientRect(), top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
   return {found:true, clickable:!!(top&&(el===top||el.contains(top))), topEl:top?top.tagName:'null'};
 });
 console.log(JSON.stringify(st,null,1));
} finally { await p.close(); await b.close(); }
