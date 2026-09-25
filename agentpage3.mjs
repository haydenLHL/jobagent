import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://jobright.ai/agent',{waitUntil:'domcontentloaded',timeout:25000});
await p.waitForTimeout(6000);
await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
const before=p.url();
const card=p.locator('text=Software Development Engineer Intern').first();
console.log('card found:', await card.count());
if(await card.count()){
  await card.click({timeout:8000}).catch(e=>console.log('click err:',e.message.slice(0,50)));
  await p.waitForTimeout(3000);
  console.log('url changed:', p.url()!==before, '| new url:', p.url());
}
await p.close(); await b.close();
