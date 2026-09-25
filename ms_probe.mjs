import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
for(const pg of c.pages()) if(/intern-list|minisites/.test(pg.url())) await pg.close().catch(()=>{});
const p=await c.newPage();
await p.goto('https://jobright.ai/minisites-jobs/intern/us/swe',{waitUntil:'domcontentloaded',timeout:35000});
await p.waitForTimeout(7000);
const r=await p.evaluate(()=>{
  const applies=[...document.querySelectorAll('*')].filter(e=>/^(👉\s*)?Apply$/i.test((e.innerText||'').trim()) && e.children.length<=1);
  // row context for the first few
  const rows=applies.slice(0,4).map(e=>{
    const row=e.closest('[class*=row],[class*=Row],tr,[role=row]')||e.parentElement?.parentElement?.parentElement;
    return (row?row.innerText:'').replace(/\s+/g,' ').slice(0,110);
  });
  return {applies:applies.length, rows, title:document.title};
});
console.log('title:', r.title);
console.log('apply buttons:', r.applies);
r.rows.forEach((x,i)=>console.log(`  row${i+1}: ${x}`));
// click first Apply, observe
const before=c.pages().length;
const el=p.locator('text=/^👉?\\s*Apply$/').first();
console.log('locator count:', await el.count());
await el.click({timeout:10000}).then(()=>console.log('clicked')).catch(e=>console.log('err:',e.message.slice(0,50)));
await p.waitForTimeout(9000);
console.log('tabs', before, '->', c.pages().length);
c.pages().forEach(x=>console.log('   ', x.url().slice(0,115)));
await b.close();
