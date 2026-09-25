import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const t=c.pages().find(x=>/ashbyhq\.com/.test(x.url()));
if(!t){ console.log('no ashby tab open. tabs:'); c.pages().forEach(x=>console.log('  ',x.url().slice(0,85))); await b.close(); process.exit(0); }
console.log('reading:', t.url().slice(0,95));
const r=await t.evaluate(()=>{
  const filled=[], empty=[], checkedOn=[];
  document.querySelectorAll('input,select,textarea').forEach(el=>{
    const ty=(el.type||el.tagName).toLowerCase();
    if(['hidden','submit','button'].includes(ty))return;
    let lab=''; if(el.id){const l=document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if(l)lab=l.innerText;}
    if(!lab)lab=(el.closest('label')?.innerText)||el.getAttribute('aria-label')||el.name||el.placeholder||'';
    lab=lab.replace(/\s+/g,' ').trim().slice(0,50);
    const req=!!(el.required||el.getAttribute('aria-required')==='true');
    if(ty==='checkbox'||ty==='radio'){ if(el.checked) checkedOn.push(`${ty}:${lab}`); return; }
    const v=String(el.value||'');
    (v? filled: empty).push(`[${ty}]${req?'*':' '} ${lab} ${v?'= "'+v.slice(0,34)+'"':''}`);
  });
  const rc = !!document.querySelector('[name=g-recaptcha-response], .g-recaptcha, iframe[src*=recaptcha]');
  return {filled,empty,checkedOn,rc};
});
console.log(`\n=== AUTOFILL FILLED (${r.filled.length}) ===`); r.filled.forEach(x=>console.log('  ',x));
console.log(`\n=== STILL EMPTY (${r.empty.length}) ===`); r.empty.forEach(x=>console.log('  ',x));
console.log(`\n=== CHECKED (${r.checkedOn.length}) ===`); r.checkedOn.forEach(x=>console.log('  ',x));
console.log('\nreCAPTCHA present:', r.rc);
await b.close();
