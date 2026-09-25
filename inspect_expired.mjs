import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
const r=await p.evaluate(()=>{
  const hdr=(document.body.innerText||'').replace(/\s+/g,' ').slice(0,160);
  const bs=[...document.querySelectorAll('[class*=job-agent-bubble]')];
  const last4=bs.slice(-4).map(e=>({
    txt:(e.innerText||'').replace(/\s+/g,' ').slice(0,180),
    btns:[...e.querySelectorAll('button')].map(x=>({t:(x.innerText||'').trim(), w:x.offsetWidth, dis:x.disabled}))
  }));
  return {hdr, total:bs.length, last4};
});
console.log('header:', r.hdr);
console.log('bubbles:', r.total);
r.last4.forEach((x,i)=>console.log(`\n[-${r.last4.length-i}] ${x.txt}\n    btns=${JSON.stringify(x.btns)}`));
await b.close();
