import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
const r=await p.evaluate(()=>{
  const hdr=(document.body.innerText||'').replace(/\s+/g,' ').slice(0,140);
  const bs=[...document.querySelectorAll('[class*=job-agent-bubble]')];
  return {hdr, n:bs.length, last3:bs.slice(-3).map(e=>({
    t:(e.innerText||'').replace(/\s+/g,' ').slice(0,160),
    btns:[...e.querySelectorAll('button')].map(x=>(x.innerText||'').trim()).filter(Boolean)
  }))};
});
console.log('header:', r.hdr);
console.log('bubbles:', r.n);
r.last3.forEach((x,i)=>console.log(`  [-${r.last3.length-i}] ${x.t}\n       btns=${JSON.stringify(x.btns)}`));
console.log('tabs:'); c.pages().forEach(x=>console.log('  ',x.url().slice(0,85)));
await b.close();
