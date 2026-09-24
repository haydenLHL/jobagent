import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const t=c.pages().find(x=>/indeed\.com/.test(x.url()));
if(t){
  const r=await t.evaluate(()=>({
    url: location.href.slice(0,120),
    hasPw: document.querySelectorAll('input[type=password]').length,
    hasEmail: document.querySelectorAll('input[type=email]').length,
    body: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,200)
  })).catch(e=>({err:e.message}));
  console.log(JSON.stringify(r,null,1));
} else console.log('no indeed tab');
await b.close();
