import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const t=c.pages().find(x=>!/jobright\.ai/.test(x.url()));
if(!t){console.log('no ATS tab'); await b.close(); process.exit(0);}
await t.bringToFront();
await t.waitForTimeout(3000);
const scan=()=>t.evaluate(()=>{
  let filled=0,total=0; const req=[];
  document.querySelectorAll('input,select,textarea').forEach(e=>{
    const ty=(e.type||e.tagName).toLowerCase();
    if(['hidden','submit','button'].includes(ty))return; total++;
    if(ty==='checkbox'||ty==='radio'){ if(e.checked)filled++; return; }
    if(String(e.value||'').trim()){filled++;return;}
    if(e.required||e.getAttribute('aria-required')==='true'){
      let l=''; if(e.id){const x=document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if(x)l=x.innerText;}
      req.push(((l||e.name||'(unlabeled)').replace(/\s+/g,' ').trim()).slice(0,55));
    }
  });
  return {filled,total,req,
    captcha: !!document.querySelector('iframe[src*=recaptcha],iframe[src*=hcaptcha]'),
    pw: document.querySelectorAll('input[type=password]').length,
    ext: !!document.querySelector('plasmo-csui#jobright-helper-plugin,PLASMO-CSUI#jobright-helper-plugin')};
});
console.log('url:', t.url().slice(0,100));
console.log('initial:', JSON.stringify(await scan()));
// click extension Autofill (shadow DOM, trusted click)
const af=t.locator('button',{hasText:/^Autofill$/}).first();
console.log('ext Autofill btn count:', await af.count().catch(()=>0));
if(await af.count().catch(()=>0)){
  await af.click({timeout:9000}).then(()=>console.log('clicked ext Autofill')).catch(e=>console.log('err',e.message.slice(0,50)));
  let prev=-1;
  for(let k=0;k<6;k++){ await t.waitForTimeout(3500); const s=await scan(); if(s.filled===prev)break; prev=s.filled; }
}
console.log('after ext autofill:', JSON.stringify(await scan()));
await b.close();
