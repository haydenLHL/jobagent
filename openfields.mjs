import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
await p.bringToFront();
const btn=p.locator('button:has-text("Fill in Missing Fields"), :text("Fill in Missing Fields")').first();
console.log('fill-fields control count:', await btn.count());
await btn.click({timeout:8000}).then(()=>console.log('clicked')).catch(e=>console.log('err:',e.message.slice(0,60)));
await p.waitForTimeout(5000);
const r=await p.evaluate(()=>{
  const txt=(document.body.innerText||'').replace(/\s+/g,' ');
  const flds=[...document.querySelectorAll('input,textarea,select')].map(e=>{
    const ty=(e.type||e.tagName).toLowerCase();
    let l=''; if(e.id){const x=document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if(x)l=x.innerText;}
    const box=e.closest('div[class*=field],div[class*=question],div[class*=form]');
    l=(l||e.closest('label')?.innerText||(box?box.innerText:'')||e.getAttribute('aria-label')||e.placeholder||e.name||'').replace(/\s+/g,' ').trim();
    return {ty,l:l.slice(0,130),v:String(e.value||'').slice(0,25)};
  }).filter(f=>!['hidden','submit','button'].includes(f.ty));
  const modal=document.querySelector('.ant-modal,[role=dialog]');
  return {modal: modal?(modal.innerText||'').replace(/\s+/g,' ').slice(0,400):null, fields:flds.slice(0,16),
          bs:[...document.querySelectorAll('button')].map(x=>(x.innerText||'').trim()).filter(t=>t&&t.length<30).slice(0,16)};
});
console.log('modal:', r.modal);
console.log('--- fields ---'); r.fields.forEach(f=>console.log(`  [${f.ty}] "${f.l}" = "${f.v}"`));
console.log('buttons:', JSON.stringify(r.bs));
await b.close();
