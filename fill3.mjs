import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
for(const pg of c.pages()) if(/ashbyhq/.test(pg.url())) await pg.close().catch(()=>{});
const p=await c.newPage();
try{
 await p.goto('https://jobright.ai/jobs/info/6aa4924f8275e3a211760d71',{waitUntil:'domcontentloaded',timeout:45000});
 await p.waitForTimeout(7000);
 await p.evaluate(()=>{const t=document.getElementById('___reactour'); if(t)t.remove();});
 const popupP=c.waitForEvent('page',{timeout:35000}).catch(()=>null);
 await p.locator('button:has-text("APPLY WITH AUTOFILL")').first().click({timeout:12000})
   .then(()=>console.log('TRUSTED click ok'))
   .catch(e=>console.log('click err:',e.message.slice(0,70)));
 const pop=await popupP;
 console.log('popup opened:', !!pop);
 const t=pop||c.pages().find(x=>/ashbyhq/.test(x.url()))||p;
 await t.waitForLoadState('domcontentloaded').catch(()=>{});
 for(let i=1;i<=5;i++){
   await t.waitForTimeout(6000);
   const n=await t.evaluate(()=>{let k=0;document.querySelectorAll('input,textarea').forEach(e=>{if(!['hidden','submit','button','file'].includes((e.type||'').toLowerCase())&&String(e.value||'').trim())k++;});return k;}).catch(()=>-1);
   console.log(`  t+${i*6}s filled non-empty inputs: ${n}`);
 }
 console.log('target:', t.url().slice(0,95));
} finally { await b.close(); }
