import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://jobright.ai/agent',{waitUntil:'domcontentloaded',timeout:25000});
await p.waitForTimeout(7000);
await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
const before=p.url();
const beforeTabs=c.pages().length;
const card=p.locator('[class*=job-card__]').first();
console.log('card count:', await card.count());
await card.click({timeout:8000}).catch(e=>console.log('click err:',e.message.slice(0,50)));
await p.waitForTimeout(3500);
console.log('url:', p.url(), '| changed:', p.url()!==before);
console.log('new tabs opened:', c.pages().length - beforeTabs);
const modal=await p.evaluate(()=>!!document.querySelector('.ant-modal,[role=dialog]'));
console.log('modal opened:', modal);
if(modal){
  const mtxt=await p.evaluate(()=>(document.querySelector('.ant-modal,[role=dialog]').innerText||'').replace(/\s+/g,' ').slice(0,300));
  console.log('modal text:', mtxt);
}
await p.close(); await b.close();
