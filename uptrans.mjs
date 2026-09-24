import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const t=c.pages().filter(x=>/ashbyhq/.test(x.url()))[0];
for(const f of await t.locator('input[type=file]').all()){
  const full=await f.evaluate(e=>{
    let l=''; if(e.id){const x=document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if(x)l=x.innerText;}
    return (l||e.closest('label')?.innerText||e.name||'').replace(/\s+/g,' ').trim();   // NO truncation
  });
  if(/transcript/i.test(full)){
    await f.setInputFiles(process.env.HOME+'/.jobagent/transcript.pdf')
      .then(()=>console.log('transcript uploaded'))
      .catch(e=>console.log('fail:',e.message.slice(0,60)));
  }
}
await t.waitForTimeout(2500);
const st=await t.evaluate(()=>Array.from(document.querySelectorAll('input[type=file]')).map(e=>({req:e.required,n:e.files?e.files.length:0,v:(e.value||'').slice(0,34)})));
console.log('file state:', JSON.stringify(st));
const empt=await t.evaluate(()=>{const o=[];document.querySelectorAll('input,select,textarea').forEach(e=>{const ty=(e.type||e.tagName).toLowerCase();if(['hidden','submit','button','checkbox','radio'].includes(ty))return;if(!String(e.value||'').trim()){let l='';if(e.id){const x=document.querySelector(`label[for="${CSS.escape(e.id)}"]`);if(x)l=x.innerText;}o.push(((l||e.name||'').replace(/\s+/g,' ').trim()||'(unlabeled)')+(e.required?' *REQUIRED':''));}});return o;});
console.log('still empty:', JSON.stringify(empt));
await b.close();
