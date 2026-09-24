import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://jobright.ai/agent',{waitUntil:'domcontentloaded',timeout:25000});
await p.waitForTimeout(7000);
await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
const card=p.locator('[class*=job-card__]').first();
await card.hover({timeout:5000}).catch(()=>{});
await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{
  const c=document.querySelector('[class*=job-card__]');
  const bs=[...c.querySelectorAll('button,a,[role=button]')].map(e=>(e.innerText||e.getAttribute('aria-label')||'').trim()).filter(Boolean);
  return {buttons:bs, html: c.outerHTML.slice(0,900)};
});
console.log('buttons inside card:', JSON.stringify(r.buttons));
console.log('--- html sample ---');
console.log(r.html);
await p.close(); await b.close();
