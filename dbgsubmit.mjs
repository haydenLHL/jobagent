import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://jobright.ai/jobs/info/6aa204852f936e4a53daf36d',{waitUntil:'domcontentloaded',timeout:25000});
await p.waitForTimeout(3500);
await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
await p.locator('button:has-text("EASY APPLY")').first().click({timeout:10000}).catch(e=>console.log('easy err',e.message.slice(0,40)));
await p.waitForTimeout(4000);
const sa=p.locator('button:has-text("Start to Autofill")').first();
if(await sa.count()){ await sa.click({timeout:8000}).catch(()=>{}); await p.waitForTimeout(9000); }
const pre=await p.evaluate(()=>{
  const m=document.querySelector('.ant-modal,[role=dialog]');
  return {fields:m.querySelectorAll('[class*=gh-autofill-popup-field]').length,
          errs:[...m.querySelectorAll('[class*=error],[class*=Error],.ant-form-item-explain')].map(e=>(e.innerText||'').trim()).filter(Boolean).slice(0,6)};
});
console.log('pre-submit:', JSON.stringify(pre));
const sb=p.locator('.ant-modal button, [role=dialog] button').filter({hasText:/^Submit$/}).first();
console.log('submit btn count:', await sb.count(), '| enabled:', await sb.isEnabled().catch(()=>'?'));
await sb.click({timeout:12000}).then(()=>console.log('clicked Submit')).catch(e=>console.log('submit err:',e.message.slice(0,60)));
await p.waitForTimeout(10000);
const post=await p.evaluate(()=>{
  const m=document.querySelector('.ant-modal,[role=dialog]');
  const errs=m?[...m.querySelectorAll('[class*=error],[class*=Error],.ant-form-item-explain,[class*=required]')].map(e=>(e.innerText||'').trim()).filter(Boolean).slice(0,8):[];
  const scrolled=m?(m.innerText||'').replace(/\s+/g,' ').slice(0,240):null;
  return {modalStillOpen:!!m, errs, head:scrolled};
});
console.log('modal still open:', post.modalStillOpen);
console.log('errors:', JSON.stringify(post.errs));
console.log('modal head:', post.head);
await b.close();
