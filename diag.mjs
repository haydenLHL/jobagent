import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0]; const p=await c.newPage();
try{
 await p.goto('https://jobright.ai/jobs/info/6aa4924f8275e3a211760d71',{waitUntil:'domcontentloaded',timeout:45000});
 await p.waitForTimeout(6000);
 const n=await p.locator('button:has-text("APPLY WITH AUTOFILL")').count();
 console.log('matching buttons:', n);
 const info=await p.evaluate(()=>{
   const out=[];
   Array.from(document.querySelectorAll('button')).forEach((el,i)=>{
     const t=(el.innerText||'').replace(/\s+/g,' ').trim();
     if(!/AUTOFILL/i.test(t))return;
     const r=el.getBoundingClientRect();
     const cx=r.left+r.width/2, cy=r.top+r.height/2;
     const top=document.elementFromPoint(cx,cy);
     out.push({i,t:t.slice(0,30),rect:`${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)}`,
       disabled:el.disabled, pe:getComputedStyle(el).pointerEvents, vis:getComputedStyle(el).visibility,
       topEl: top? top.tagName+'.'+(top.className||'').toString().slice(0,40) : 'null',
       isSelfOrChild: !!(top && (el===top || el.contains(top)))});
   });
   return {out, vw:innerWidth, vh:innerHeight, scrollY:scrollY};
 });
 console.log('viewport', info.vw+'x'+info.vh, 'scrollY', info.scrollY);
 info.out.forEach(o=>console.log(JSON.stringify(o)));
} finally { await p.close(); await b.close(); }
