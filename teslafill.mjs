import { chromium } from 'playwright-core';
import { BANK } from './profile.mjs';
function bankValue(lab){
  const l=lab.toLowerCase();
  if(/full name|your name|^name$/.test(l))return null;
  if(/first|given/.test(l))return BANK.firstName;
  if(/last|family|surname/.test(l))return BANK.lastName;
  if(/e-?mail/.test(l))return BANK.email;
  if(/phone|mobile|^tel/.test(l))return BANK.phone;
  return null;
}
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0]; const t=await c.newPage();
await t.goto('https://www.tesla.com/careers/search/job/apply/282774?source=Indeed', {waitUntil:'domcontentloaded', timeout:25000});
await t.waitForTimeout(4000);
let filled=0;
for(const el of await t.locator('input:visible, textarea:visible').all()){
  const meta=await el.evaluate(e=>{
    const ty=(e.type||e.tagName).toLowerCase();
    let l=''; if(e.id){const x=document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if(x)l=x.innerText;}
    l=(l||e.closest('label')?.innerText||e.getAttribute('aria-label')||e.name||e.placeholder||'').replace(/\s+/g,' ').trim();
    return {ty,l,v:String(e.value||'')};
  }).catch(e=>({err:e.message}));
  if(meta.err){console.log('eval err:', meta.err.slice(0,60)); continue;}
  if(meta.v || ['hidden','submit','button','checkbox','radio','file'].includes(meta.ty)){console.log('skip (has value or type):', meta.ty, meta.l); continue;}
  const v=bankValue(meta.l);
  if(!v){console.log('NO BANK MATCH for label:', JSON.stringify(meta.l)); continue;}
  await el.fill(v,{timeout:4000}).then(()=>{filled++; console.log('FILLED', meta.l, '->', v);}).catch(e=>console.log('FILL FAILED', meta.l, ':', e.message.slice(0,70)));
}
console.log('total filled:', filled);
await t.close(); await b.close();
