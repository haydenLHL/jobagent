import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
console.log('tabs:'); c.pages().forEach(x=>console.log('  ',x.url().slice(0,100)));
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
const r=await p.evaluate(()=>{
  const bs=[...document.querySelectorAll('[class*=job-agent-bubble]')];
  const last=(bs[bs.length-1].innerText||'').replace(/\s+/g,' ');
  const btns=[...bs[bs.length-1].querySelectorAll('button')].map(x=>(x.innerText||'').trim()).filter(Boolean);
  return {last:last.slice(0,400), btns};
});
console.log('active bubble:', r.last);
console.log('buttons:', JSON.stringify(r.btns));
await b.close();
