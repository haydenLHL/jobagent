import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
try{
 await p.goto('https://jobright.ai/jobs/info/6aa4924f8275e3a211760d71',{waitUntil:'domcontentloaded',timeout:45000});
 await p.waitForTimeout(7000);
 const killed=await p.evaluate(()=>{const t=document.getElementById('___reactour'); if(t){t.remove();return true;} return false;});
 console.log('overlay removed:', killed);
 const popupP=c.waitForEvent('page',{timeout:30000}).catch(()=>null);
 const clicked=await p.evaluate(()=>{
   const el=Array.from(document.querySelectorAll('button')).find(x=>/AUTOFILL/i.test(x.innerText||''));
   if(!el)return false; el.click(); return true;
 });
 console.log('autofill dispatched:', clicked);
 const pop=await popupP;
 await p.waitForTimeout(12000);
 const t=pop||p;
 console.log('popup:', !!pop, '| url:', t.url().slice(0,100));
 const f=await t.evaluate(()=>{
   const r=[];
   document.querySelectorAll('input,select,textarea').forEach(el=>{
     const ty=(el.type||el.tagName).toLowerCase();
     if(['hidden','submit','button'].includes(ty))return;
     let lab=''; if(el.id){const l=document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if(l)lab=l.innerText;}
     if(!lab)lab=(el.closest('label')?.innerText)||el.getAttribute('aria-label')||el.name||el.placeholder||'';
     r.push({ty,lab:lab.replace(/\s+/g,' ').trim().slice(0,54),val:String(el.value||'').slice(0,30),req:!!(el.required||el.getAttribute('aria-required')==='true')});
   });
   return r;
 }).catch(e=>[{ty:'ERR',lab:e.message.slice(0,60),val:'',req:false}]);
 console.log(`--- ${f.length} fields on target ---`);
 f.forEach(x=>console.log(`  [${x.ty}]${x.req?'*':' '} ${x.lab.padEnd(54)} = ${x.val?'"'+x.val+'"':'(EMPTY)'}`));
} finally { await b.close(); }
