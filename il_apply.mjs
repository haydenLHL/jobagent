import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://www.intern-list.com/',{waitUntil:'domcontentloaded',timeout:35000});
await p.waitForTimeout(7000);
const r=await p.evaluate(()=>{
  const els=[...document.querySelectorAll('*')].filter(e=>{
    const t=(e.innerText||'').trim();
    return /^(👉\s*)?Apply$/i.test(t) && e.children.length<=1;
  });
  return {count:els.length, sample:els.slice(0,3).map(e=>({tag:e.tagName,
    cls:(typeof e.className==='string'?e.className:'').slice(0,50),
    href:e.getAttribute('href')||e.closest('a')?.getAttribute('href')||''}))};
});
console.log('Apply elements:', r.count);
console.log(JSON.stringify(r.sample,null,1));
// click the first one and see where it goes
const before=c.pages().length;
const el=p.locator('text=/^👉?\\s*Apply$/').first();
console.log('locator count:', await el.count());
await el.click({timeout:10000}).then(()=>console.log('clicked Apply')).catch(e=>console.log('err:',e.message.slice(0,60)));
await p.waitForTimeout(8000);
console.log('tabs', before, '->', c.pages().length);
c.pages().forEach(x=>console.log('   ', x.url().slice(0,110)));
await b.close();
