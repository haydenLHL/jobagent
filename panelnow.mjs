import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
console.log('tabs:'); c.pages().forEach(x=>console.log('  ',x.url().slice(0,90)));
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
if(!p){console.log('no agent tab'); await b.close(); process.exit(0);}
const r=await p.evaluate(()=>{
  const txt=(document.body.innerText||'').replace(/\s+/g,' ');
  const i=txt.indexOf('Action Required');
  const flds=[...document.querySelectorAll('input,textarea,select')].map(e=>{
    const ty=(e.type||e.tagName).toLowerCase();
    const box=e.closest('div[class*=field],div[class*=question],div[class*=form-item],div');
    let l=''; if(e.id){const x=document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if(x)l=x.innerText;}
    l=(l||e.closest('label')?.innerText||(box?box.innerText:'')||e.getAttribute('aria-label')||e.placeholder||e.name||'').replace(/\s+/g,' ').trim();
    return {ty, l:l.slice(0,110), v:String(e.value||'').slice(0,30)};
  }).filter(f=>!['hidden','submit','button'].includes(f.ty));
  return {header:(txt.match(/(Standby|Executing|Paused|Completed)[^.]*\./)||[])[0]||'',
          snippet: i>=0? txt.slice(i, i+420):'(no Action Required)', fields:flds.slice(0,14)};
});
console.log('header:', r.header);
console.log('panel:', r.snippet);
console.log('--- form fields ---'); r.fields.forEach(f=>console.log(`  [${f.ty}] "${f.l}" = "${f.v}"`));
await b.close();
