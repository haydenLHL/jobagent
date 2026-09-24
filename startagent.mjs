import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://jobright.ai/agent',{waitUntil:'domcontentloaded',timeout:25000});
await p.waitForTimeout(6000);
await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
const startBtn=p.locator('button:has-text("Start")').first();
console.log('start button count:', await startBtn.count());
await startBtn.click({timeout:10000}).then(()=>console.log('clicked Start')).catch(e=>console.log('click err:',e.message.slice(0,60)));
await p.waitForTimeout(6000);
const r=await p.evaluate(()=>{
  const modal=document.querySelector('.ant-modal,[role=dialog]');
  return {
    url: location.href,
    modalOpen: !!modal,
    modalText: modal?(modal.innerText||'').replace(/\s+/g,' ').slice(0,400):null,
    bodyHead: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,500),
  };
});
console.log('url:', r.url);
console.log('modal open:', r.modalOpen);
console.log('modal text:', r.modalText);
console.log('body head:', r.bodyHead);
await p.close(); await b.close();
