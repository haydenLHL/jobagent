import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const t=c.pages().filter(x=>/ashbyhq/.test(x.url()))[0];
const r=await t.evaluate(()=>Array.from(document.querySelectorAll('select')).map((s,i)=>({
  i, value:s.value,
  opts:Array.from(s.options).map(o=>o.value).filter(Boolean).slice(0,16).join(','),
  near:(s.closest('div')?.parentElement?.innerText||'').replace(/\s+/g,' ').trim().slice(0,60)
})));
r.forEach(x=>console.log(`select[${x.i}] value="${x.value}" opts=[${x.opts}]\n   near: ${x.near}`));
// upload transcript now
for(const f of await t.locator('input[type=file]').all()){
  const l=await f.evaluate(e=>{let s=''; if(e.id){const x=document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if(x)s=x.innerText;} return (s||e.closest('label')?.innerText||e.name||'').replace(/\s+/g,' ').trim().slice(0,45);});
  if(/transcript/i.test(l)) await f.setInputFiles(process.env.HOME+'/.jobagent/transcript.pdf').then(()=>console.log('\ntranscript uploaded OK')).catch(e=>console.log('\ntranscript fail:',e.message.slice(0,50)));
}
await b.close();
