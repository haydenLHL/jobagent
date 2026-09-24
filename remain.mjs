import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const t=c.pages().filter(x=>/ashbyhq/.test(x.url()))[0];
const r=await t.evaluate(()=>{
  const F=[],E=[],C=[];
  document.querySelectorAll('input,textarea,select').forEach(e=>{
    const ty=(e.type||e.tagName).toLowerCase();
    if(['hidden','submit','button'].includes(ty))return;
    let lab=''; if(e.id){const l=document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if(l)lab=l.innerText;}
    if(!lab)lab=(e.closest('label')?.innerText)||e.getAttribute('aria-label')||e.name||e.placeholder||'';
    lab=lab.replace(/\s+/g,' ').trim().slice(0,52);
    const req=!!(e.required||e.getAttribute('aria-required')==='true');
    if(ty==='checkbox'||ty==='radio'){ if(e.checked)C.push(`${lab}`); return; }
    const v=String(e.value||'').trim();
    (v?F:E).push(`[${ty}]${req?'*':' '} ${lab}${v?' = "'+v.slice(0,32)+'"':''}`);
  });
  const rc=!!document.querySelector('iframe[src*=recaptcha]');
  return {F,E,C,rc};
});
console.log(`=== FILLED (${r.F.length}) ===`); r.F.forEach(x=>console.log('  ',x));
console.log(`=== CHECKED (${r.C.length}) ===`); r.C.forEach(x=>console.log('  ',x));
console.log(`=== STILL EMPTY (${r.E.length}) ===`); r.E.forEach(x=>console.log('  ',x));
console.log('reCAPTCHA iframe:', r.rc);
await b.close();
