import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://jobright.ai/agent',{waitUntil:'domcontentloaded',timeout:25000});
await p.waitForTimeout(7000);
await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
const r=await p.evaluate(()=>{
  const els=[...document.querySelectorAll('[class*=card],[class*=job],[data-testid*=job]')];
  return els.slice(0,5).map(e=>({cls:(e.className||'').toString().slice(0,50), txt:(e.innerText||'').replace(/\s+/g,' ').slice(0,60), clickable: getComputedStyle(e).cursor}));
});
console.log(JSON.stringify(r,null,1));
const before=p.url();
const anyCard=p.locator('[class*=card]').first();
console.log('any card count:', await anyCard.count());
if(await anyCard.count()){
  await anyCard.click({timeout:8000}).catch(e=>console.log('click err:',e.message.slice(0,50)));
  await p.waitForTimeout(3000);
  console.log('url after click:', p.url());
}
await p.close(); await b.close();
