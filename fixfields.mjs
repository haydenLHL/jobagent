import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
await p.bringToFront();
const r=await p.evaluate(()=>{
  const flds=[...document.querySelectorAll('input,textarea,select')].map(e=>{
    const ty=(e.type||e.tagName).toLowerCase();
    let l=''; if(e.id){const x=document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if(x)l=x.innerText;}
    const box=e.closest('div[class*=field],div[class*=question],div[class*=item],div');
    l=(l||e.closest('label')?.innerText||(box?box.innerText:'')||e.getAttribute('aria-label')||e.placeholder||e.name||'').replace(/\s+/g,' ').trim();
    return {ty,l:l.slice(0,140),v:String(e.value||'').slice(0,25)};
  }).filter(f=>!['hidden','submit','button'].includes(f.ty));
  const radios=[...document.querySelectorAll('input[type=radio]')].length;
  const modal=document.querySelector('.ant-modal,[role=dialog]');
  return {fields:flds.slice(0,18), radios, modal: modal?(modal.innerText||'').replace(/\s+/g,' ').slice(0,300):null};
});
console.log('modal:', r.modal);
console.log('radios on page:', r.radios);
console.log('--- fields ---'); r.fields.forEach(f=>console.log(`  [${f.ty}] "${f.l}" = "${f.v}"`));
await b.close();
