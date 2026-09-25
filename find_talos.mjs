import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
const r=await p.evaluate(()=>{
  const bs=[...document.querySelectorAll('[class*=job-agent-bubble]')];
  const out=[];
  bs.forEach((e,k)=>{
    const t=(e.innerText||'').replace(/\s+/g,' ');
    if(/Talos/i.test(t) && /Action Required|required fields|Autofill/i.test(t)){
      out.push({idx:k, txt:t.slice(0,340),
        btns:[...e.querySelectorAll('button')].map(x=>(x.innerText||'').trim()).filter(Boolean)});
    }
  });
  return out.slice(-3);
});
r.forEach(x=>console.log(`\n[idx ${x.idx}] ${x.txt}\n   btns=${JSON.stringify(x.btns)}`));
if(!r.length) console.log('no Talos bubbles found');
await b.close();
