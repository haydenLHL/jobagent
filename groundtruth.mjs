import { chromium } from 'playwright-core';
const J=[['6aa45803f7baf881567ce618','Lyft Fullstack'],['6aa480ce422289703bd66d84','Lyft Backend'],
         ['6aa43a20c1928370a285d204','Veeam Policy'],['6aa4d98782e82a31997baf9d','NewsBreak Nearby AI'],
         ['6aa204852f936e4a53daf36d','Epic Games Backend']];
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0]; const p=await c.newPage();
for(const [id,name] of J){
  await p.goto(`https://jobright.ai/jobs/info/${id}`,{waitUntil:'domcontentloaded',timeout:25000}).catch(()=>{});
  await p.waitForTimeout(3800);
  await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
  const r=await p.evaluate(()=>{
    const bs=[...document.querySelectorAll('button')].map(e=>(e.innerText||'').replace(/\s+/g,' ').trim());
    return {easy:bs.some(x=>/EASY APPLY/i.test(x)), auto:bs.some(x=>/APPLY WITH AUTOFILL/i.test(x))};
  });
  const verdict = (!r.easy && !r.auto) ? 'APPLIED (apply button gone)' : 'NOT APPLIED (button still present)';
  console.log(`${verdict.padEnd(34)} ${name}`);
}
await p.close(); await b.close();
