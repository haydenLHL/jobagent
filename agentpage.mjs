import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://jobright.ai/agent',{waitUntil:'domcontentloaded',timeout:25000});
await p.waitForTimeout(6000);
await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
const r=await p.evaluate(()=>{
  const bs=[...document.querySelectorAll('button,a')].map(e=>(e.innerText||'').replace(/\s+/g,' ').trim()).filter(s=>s&&s.length<40);
  return {title:document.title, url:location.href, body:(document.body.innerText||'').replace(/\s+/g,' ').slice(0,600), bs:[...new Set(bs)].slice(0,25)};
});
console.log('title:', r.title);
console.log('url:', r.url);
console.log('buttons:', JSON.stringify(r.bs));
console.log('body:', r.body);
await p.close(); await b.close();
