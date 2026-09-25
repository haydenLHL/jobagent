import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
await p.bringToFront();
const beforeTabs=c.pages().length;
const btn=p.locator('button:has-text("Continue")').first();
console.log('continue btn count:', await btn.count());
await btn.click({timeout:10000}).then(()=>console.log('clicked Continue')).catch(e=>console.log('err:',e.message.slice(0,50)));
await p.waitForTimeout(7000);
console.log('new tabs:', c.pages().length - beforeTabs);
c.pages().forEach(x=>console.log('  tab:', x.url().slice(0,90)));
const r=await p.evaluate(()=>{
  const modal=document.querySelector('.ant-modal,[role=dialog]');
  return {modalOpen: !!modal, modalText: modal?(modal.innerText||'').replace(/\s+/g,' ').slice(0,300):null,
          body:(document.body.innerText||'').replace(/\s+/g,' ').slice(0,400)};
});
console.log('modal:', r.modalOpen, r.modalText);
console.log('body:', r.body);
await b.close();
