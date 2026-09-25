import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
try{
 await p.goto('https://jobright.ai/jobs/info/6aa4924f8275e3a211760d71',{waitUntil:'domcontentloaded',timeout:45000});
 await p.waitForTimeout(6000);
 const r=await p.evaluate(()=>{
   const top=document.elementFromPoint(751+97, 80+16);
   const chain=[]; let e=top;
   while(e && chain.length<7){ chain.push(`${e.tagName}${e.id?'#'+e.id:''}.${(typeof e.className==='string'?e.className:'(svg)').slice(0,45)} z=${getComputedStyle(e).zIndex} pos=${getComputedStyle(e).position}`); e=e.parentElement; }
   // look for tour/onboarding containers + dismissers
   const dis=[];
   document.querySelectorAll('button,[role=button],svg,div').forEach(el=>{
     const t=(el.innerText||'').replace(/\s+/g,' ').trim();
     const cls=(typeof el.className==='string'?el.className:'');
     if(/skip|got it|next|close|dismiss|×|tour|onboard|driver|intro|joyride|shepherd/i.test(t+' '+cls) && t.length<26)
       dis.push(`${el.tagName}."${cls.slice(0,38)}" txt="${t.slice(0,22)}"`);
   });
   return {chain, dis:[...new Set(dis)].slice(0,12)};
 });
 console.log('--- element stack over button ---'); r.chain.forEach(x=>console.log('  ',x));
 console.log('--- possible dismissers ---'); r.dis.forEach(x=>console.log('  ',x));
} finally { await p.close(); await b.close(); }
