import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
const r=await p.evaluate(()=>{
  const txt=(document.body.innerText||'').replace(/\s+/g,' ');
  const i=txt.indexOf('Action Required');
  return {len:txt.length, head:txt.slice(0,200), around: i>=0?txt.slice(Math.max(0,i-200), i+600):'(none)'};
});
console.log('HEAD:', r.head);
console.log('AROUND ACTION REQUIRED:', r.around);
await b.close();
