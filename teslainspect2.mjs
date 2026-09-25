import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://www.tesla.com/careers/search/job/282774?source=Indeed',{waitUntil:'domcontentloaded',timeout:25000});
await p.waitForTimeout(4000);
const r=await p.evaluate(()=>{
  const bs=[...document.querySelectorAll('button,a')].map(e=>(e.innerText||'').replace(/\s+/g,' ').trim()).filter(s=>s&&s.length<40);
  return {bs:[...new Set(bs)], body:(document.body.innerText||'').replace(/\s+/g,' ').slice(0,400)};
});
console.log('buttons:', JSON.stringify(r.bs));
console.log('body:', r.body);
await p.close(); await b.close();
