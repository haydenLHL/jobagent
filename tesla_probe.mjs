import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://jobright.ai/jobs/info/6aa421b91d92e2d05d1137c7',{waitUntil:'domcontentloaded',timeout:25000});
await p.waitForTimeout(4000);
await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
const popP=c.waitForEvent('page',{timeout:20000}).catch(()=>null);
await p.locator('button:has-text("APPLY WITH AUTOFILL")').first().click({timeout:10000}).catch(e=>console.log('click err',e.message.slice(0,50)));
const pop=await popP;
console.log('new tab opened:', !!pop);
if(!pop){ await b.close(); process.exit(0); }
await pop.waitForLoadState('domcontentloaded').catch(()=>{});
await pop.waitForTimeout(5000);
console.log('url:', pop.url().slice(0,100));
console.log('title:', await pop.title());
const r=await pop.evaluate(()=>{
  const inputs=document.querySelectorAll('input,select,textarea').length;
  const pw=document.querySelectorAll('input[type=password]').length;
  const bs=[...document.querySelectorAll('button,a')].map(e=>(e.innerText||'').replace(/\s+/g,' ').trim()).filter(s=>s&&s.length<30);
  return {inputs, pw, bodyLen:document.body.innerText.length, bs:[...new Set(bs)].slice(0,20),
          bodyHead:(document.body.innerText||'').replace(/\s+/g,' ').slice(0,300)};
});
console.log('inputs:', r.inputs, '| password fields:', r.pw);
console.log('buttons/links:', JSON.stringify(r.bs));
console.log('body head:', r.bodyHead);
await b.close();
