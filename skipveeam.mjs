import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
await p.bringToFront();
const ok=await p.evaluate(()=>{
  const bs=[...document.querySelectorAll('[class*=job-agent-bubble]')];
  const last=bs[bs.length-1];
  const skip=[...last.querySelectorAll('button')].find(x=>/^Skip$/i.test((x.innerText||'').trim()));
  if(skip){ skip.click(); return true; }
  return false;
});
console.log('skip clicked:', ok);
await p.waitForTimeout(7000);
const st=await p.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').slice(0,120));
console.log('state:', st);
await b.close();
