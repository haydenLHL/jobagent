import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
const r=await p.evaluate(()=>{
  const bs=[...document.querySelectorAll('[class*=job-agent-bubble]')];
  const last=bs[bs.length-1];
  return {txt:(last.innerText||'').replace(/\s+/g,' ').slice(0,500),
          btns:[...last.querySelectorAll('button')].map(x=>(x.innerText||'').trim()).filter(Boolean)};
});
console.log('active bubble:', r.txt);
console.log('buttons:', JSON.stringify(r.btns));
await b.close();
