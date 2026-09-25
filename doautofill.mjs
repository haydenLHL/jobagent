import { chromium } from 'playwright-core';
const count = f => f.evaluate(()=>{
  let filled=0,empty=0;
  document.querySelectorAll('input,textarea,select').forEach(e=>{
    const ty=(e.type||e.tagName).toLowerCase();
    if(['hidden','submit','button'].includes(ty))return;
    if(ty==='checkbox'||ty==='radio'){ if(e.checked)filled++; return; }
    String(e.value||'').trim()?filled++:empty++;
  });
  return {filled,empty};
});
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const t=c.pages().filter(x=>/ashbyhq/.test(x.url()))[0];
await t.bringToFront();
console.log('before:', JSON.stringify(await count(t)));
const btn=t.locator('button', {hasText:/^Autofill$/}).first();
console.log('autofill btn count:', await btn.count());
await btn.scrollIntoViewIfNeeded({timeout:5000}).catch(()=>{});
await btn.click({timeout:10000}).then(()=>console.log('clicked Autofill'))
  .catch(async e=>{ console.log('normal click failed:',e.message.slice(0,55)); 
    await btn.click({force:true,timeout:8000}).then(()=>console.log('force click ok')).catch(e2=>console.log('force failed:',e2.message.slice(0,45))); });
for(let i=1;i<=5;i++){ await t.waitForTimeout(5000); console.log(`  t+${i*5}s`, JSON.stringify(await count(t))); }
await b.close();
