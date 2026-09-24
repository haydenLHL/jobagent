import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
console.log('all tabs:');
c.pages().forEach(p=>console.log('  ', p.url().slice(0,100)));
const pop=c.pages().find(x=>/tesla\.com/.test(x.url()));
await pop.bringToFront();
// find the Apply element precisely
const info=await pop.evaluate(()=>{
  const els=[...document.querySelectorAll('button,a,[role=button]')].filter(e=>/^apply$/i.test((e.innerText||'').trim()));
  return els.map(e=>({tag:e.tagName, href:e.getAttribute('href')||'', target:e.getAttribute('target')||'', cls:(e.className||'').toString().slice(0,50)}));
});
console.log('Apply elements:', JSON.stringify(info));
await b.close();
