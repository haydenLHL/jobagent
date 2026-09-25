import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const t=await c.newPage();
await t.goto('https://www.tesla.com/careers/search/job/apply/282774?source=Indeed', {waitUntil:'domcontentloaded', timeout:25000});
await t.waitForTimeout(4000);
const r=await t.evaluate(()=>{
  const out=[];
  document.querySelectorAll('input,select,textarea').forEach(e=>{
    const ty=(e.type||e.tagName).toLowerCase();
    let l=''; if(e.id){const x=document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if(x)l=x.innerText;}
    l=(l||e.closest('label')?.innerText||e.getAttribute('aria-label')||e.placeholder||e.name||'').replace(/\s+/g,' ').trim();
    out.push(`[${ty}] "${l.slice(0,55)}" req=${!!(e.required||e.getAttribute('aria-required')==='true')} val="${String(e.value||'').slice(0,20)}"`);
  });
  const nextBtn=[...document.querySelectorAll('button')].map(x=>(x.innerText||'').trim()).filter(x=>x&&x.length<26);
  return {out, nextBtn:[...new Set(nextBtn)]};
});
r.out.forEach(x=>console.log(' ',x));
console.log('buttons:', JSON.stringify(r.nextBtn));
await t.close(); await b.close();
