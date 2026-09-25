import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://jobright.ai/jobs/info/6aa45803f7baf881567ce618',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(5000);
await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
const popP=c.waitForEvent('page',{timeout:25000}).catch(()=>null);
await p.locator('button:has-text("EASY APPLY")').first().click({timeout:10000}).then(()=>console.log('EASY APPLY clicked')).catch(e=>console.log('click err:',e.message.slice(0,50)));
const pop=await popP;
await p.waitForTimeout(7000);
console.log('new tab:', !!pop, pop?pop.url().slice(0,95):'');
// what appeared on the jobright page?
const r=await p.evaluate(()=>{
  const m=document.querySelector('.ant-modal,[role=dialog]');
  const bs=[]; (m||document).querySelectorAll('button').forEach(e=>{const s=(e.innerText||'').replace(/\s+/g,' ').trim(); if(s&&s.length<40)bs.push(s);});
  return {modal:m?(m.innerText||'').replace(/\s+/g,' ').slice(0,300):null, bs:[...new Set(bs)].slice(0,12)};
});
console.log('modal:', r.modal);
console.log('buttons:', JSON.stringify(r.bs));
if(pop){ const f=await pop.evaluate(()=>{let n=0;document.querySelectorAll('input,textarea,select').forEach(e=>{if(String(e.value||'').trim())n++});return {n,cap:!!document.querySelector('iframe[src*=recaptcha]'),t:document.title.slice(0,50)}}).catch(()=>null); console.log('popup form:', JSON.stringify(f)); }
await b.close();
