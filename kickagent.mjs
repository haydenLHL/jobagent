import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const pages=c.pages().filter(x=>/jobright\.ai\/agent/.test(x.url()));
const p=pages[pages.length-1];
await p.bringToFront();
await p.locator('button:has-text("Pause")').first().click({timeout:8000}).then(()=>console.log('clicked Pause')).catch(e=>console.log('pause err:',e.message.slice(0,50)));
await p.waitForTimeout(3000);
console.log('state after pause:', await p.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').slice(0,100)));
const cont=p.locator('button:has-text("Continue")').first();
if(await cont.count()){
  await cont.click({timeout:8000}).then(()=>console.log('clicked Continue')).catch(e=>console.log('continue err:',e.message.slice(0,50)));
  await p.waitForTimeout(10000);
  console.log('state after continue:', await p.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').slice(0,150)));
  console.log('tabs now:'); c.pages().forEach(x=>console.log('  ',x.url().slice(0,90)));
} else {
  console.log('no continue button; current buttons:', await p.evaluate(()=>[...document.querySelectorAll('button')].map(x=>x.innerText.trim()).filter(Boolean).slice(0,10)));
}
await b.close();
