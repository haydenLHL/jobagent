import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://jobright.ai/agent',{waitUntil:'domcontentloaded',timeout:25000});
await p.waitForTimeout(6000);
await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});

console.log('=== STATE 1 ===', (await p.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').slice(0,80))));
await p.locator('button:has-text("Start")').first().click({timeout:10000});
await p.waitForTimeout(6000);
console.log('=== STATE 2 (after Start) ===', (await p.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').slice(0,100))));

const beforeTabs=c.pages().length;
await p.locator('button:has-text("Continue")').first().click({timeout:10000});
await p.waitForTimeout(8000);
console.log('=== STATE 3 (after Continue) ===');
console.log('new tabs opened:', c.pages().length - beforeTabs);
c.pages().forEach(x=>console.log('  tab:', x.url().slice(0,95)));
const r=await p.evaluate(()=>{
  const modal=document.querySelector('.ant-modal,[role=dialog]');
  return {modalOpen: !!modal, modalText: modal?(modal.innerText||'').replace(/\s+/g,' ').slice(0,400):null,
          body:(document.body.innerText||'').replace(/\s+/g,' ').slice(0,400)};
});
console.log('modal:', r.modalOpen, r.modalText);
console.log('body:', r.body);
// leave tab open for follow-up inspection - do NOT close
