import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
await p.bringToFront();
const before=await p.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').slice(0,80));
console.log('before:', before);
await p.locator('[class*=preset]:has-text("Show me more matches")').first().click({timeout:8000})
  .then(()=>console.log('clicked "Show me more matches"')).catch(e=>console.log('err:',e.message.slice(0,60)));
await p.waitForTimeout(12000);
const after=await p.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').slice(0,200));
console.log('after:', after);
await b.close();
