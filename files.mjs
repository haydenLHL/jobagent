import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const t=c.pages().filter(x=>/ashbyhq/.test(x.url()))[0];
const inputs=await t.locator('input[type=file]').all();
console.log('file inputs:', inputs.length);
for(const [i,f] of inputs.entries()){
  const meta=await f.evaluate(e=>{
    let l=''; if(e.id){const x=document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if(x)l=x.innerText;}
    return {lab:(l||e.closest('label')?.innerText||e.name||'').replace(/\s+/g,' ').trim().slice(0,55),
            req:!!e.required, val:e.value||'', files:e.files?e.files.length:0};
  });
  console.log(`  [${i}] req=${meta.req} files=${meta.files} lab="${meta.lab}" val="${meta.val.slice(0,40)}"`);
}
await b.close();
