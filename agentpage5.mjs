import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://jobright.ai/agent',{waitUntil:'domcontentloaded',timeout:25000});
await p.waitForTimeout(7000);
await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
const r=await p.evaluate(()=>{
  // find job list container - look for elements containing "% " match score text and company names
  const all=[...document.querySelectorAll('div,li')];
  const cands=all.filter(e=>{
    const t=e.innerText||'';
    return /\d{2}%/.test(t) && t.length<400 && t.length>30 && e.children.length<8;
  });
  return cands.slice(0,6).map(e=>({cls:(e.className||'').toString().slice(0,60), txt:t=>0, innerLen:e.innerText.length, sample:e.innerText.replace(/\s+/g,' ').slice(0,80)}));
});
console.log(JSON.stringify(r,null,1));
await p.close(); await b.close();
