import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
const r=await p.evaluate(()=>{
  const bs=[...document.querySelectorAll('[class*=job-agent-bubble]')];
  const out=[];
  for(let k=bs.length-1;k>=0 && out.length<4;k--){
    const t=(bs[k].innerText||'').replace(/\s+/g,' ');
    if(/Action Required/i.test(t)){
      out.push({idx:k, txt:t.slice(0,300),
        btns:[...bs[k].querySelectorAll('button')].map(x=>({t:(x.innerText||'').trim(), w:x.offsetWidth}))});
    }
  }
  const hdr=(document.body.innerText||'').replace(/\s+/g,' ').slice(0,100);
  return {hdr, out};
});
console.log('header:', r.hdr);
r.out.forEach(x=>console.log(`\n[idx ${x.idx}] ${x.txt}\n   btns=${JSON.stringify(x.btns)}`));
await b.close();
