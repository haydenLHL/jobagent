import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const pages=c.pages().filter(x=>/jobright\.ai\/agent/.test(x.url()));
console.log('agent tabs:', pages.length);
for(const [i,p] of pages.entries()){
  const r=await p.evaluate(()=>{
    const els=[...document.querySelectorAll('[class*=job-card__]')];
    return els.map(e=>(e.innerText||'').replace(/\s+/g,' ').slice(0,120));
  }).catch(e=>['ERR:'+e.message]);
  console.log(`--- tab ${i} job cards (${r.length}) ---`);
  r.forEach(x=>console.log('  ', x));
}
await b.close();
