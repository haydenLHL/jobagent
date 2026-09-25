import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const t=c.pages().find(x=>/tesla\.com\/careers\/search\/job\/apply/.test(x.url()));
if(!t){console.log('no apply tab'); await b.close(); process.exit(0);}
await t.bringToFront();
await t.waitForTimeout(3000);
const r=await t.evaluate(()=>({
  inputs: document.querySelectorAll('input,select,textarea').length,
  pw: document.querySelectorAll('input[type=password]').length,
  steps: (document.body.innerText.match(/step\s*\d+\s*of\s*\d+/i)||[])[0]||null,
  head: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,250)
}));
console.log(JSON.stringify(r,null,1));
await b.close();
