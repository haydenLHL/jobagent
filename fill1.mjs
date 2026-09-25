import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
try{
 await p.goto('https://jobright.ai/jobs/info/6aa4924f8275e3a211760d71',{waitUntil:'domcontentloaded',timeout:45000});
 await p.waitForTimeout(5000);
 const before=c.pages().length;
 const btn=p.locator('button:has-text("APPLY WITH AUTOFILL")').first();
 console.log('autofill button visible:', await btn.isVisible().catch(()=>false));
 const popupP=c.waitForEvent('page',{timeout:25000}).catch(()=>null);
 await btn.click({timeout:10000}).catch(e=>console.log('click err:',e.message.slice(0,60)));
 const pop=await popupP;
 await p.waitForTimeout(9000);
 const target = pop || p;
 console.log('new tab opened:', !!pop, '| tabs', before, '->', c.pages().length);
 console.log('target url:', target.url().slice(0,100));
 const fields=await target.evaluate(()=>{
   const r=[];
   document.querySelectorAll('input,select,textarea').forEach(el=>{
     const ty=(el.type||el.tagName).toLowerCase();
     if(['hidden','submit','button'].includes(ty))return;
     let lab=''; 
     if(el.id){const l=document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if(l)lab=l.innerText;}
     if(!lab)lab=(el.closest('label')?.innerText)||el.getAttribute('aria-label')||el.name||el.placeholder||'';
     r.push({ty, lab:lab.replace(/\s+/g,' ').trim().slice(0,58), val:String(el.value||'').slice(0,34), req:!!(el.required||el.getAttribute('aria-required')==='true')});
   });
   return r;
 }).catch(e=>[{ty:'ERR',lab:e.message.slice(0,50),val:'',req:false}]);
 console.log(`--- ${fields.length} fields ---`);
 fields.forEach(f=>console.log(`  [${f.ty}]${f.req?'*':' '} ${f.lab.padEnd(58)} = ${f.val?'"'+f.val+'"':'(EMPTY)'}`));
} finally { await b.close(); }
