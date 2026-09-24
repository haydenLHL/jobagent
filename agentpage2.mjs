import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://jobright.ai/agent',{waitUntil:'domcontentloaded',timeout:25000});
await p.waitForTimeout(6000);
await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
const r=await p.evaluate(()=>{
  const links=[...document.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')).filter(h=>h&&!/^https?:\/\/(?!jobright)/.test(h));
  const startBtn=[...document.querySelectorAll('button')].find(b=>/^Start$/i.test((b.innerText||'').trim()));
  return {links:[...new Set(links)].slice(0,20), startBtnFound: !!startBtn,
          startBtnParentText: startBtn?startBtn.closest('div')?.innerText.replace(/\s+/g,' ').slice(0,200):null};
});
console.log('links:', JSON.stringify(r.links,null,1));
console.log('start btn found:', r.startBtnFound);
console.log('start btn context:', r.startBtnParentText);
await p.close(); await b.close();
