import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const t=c.pages().filter(x=>/ashbyhq/.test(x.url()))[0];
await t.bringToFront();

// 1) education end year 2026 -> 2028
const sels=await t.locator('select').all();
for(const s of sels){
  const v=await s.inputValue().catch(()=>'');
  if(v==='2026'){
    const opts=await s.locator('option').evaluateAll(o=>o.map(x=>x.value));
    if(opts.includes('2028')){ await s.selectOption('2028'); console.log('grad year 2026 -> 2028 OK'); }
    else console.log('2028 not an option; options:', opts.slice(0,12).join(','));
  }
}

// 2) race -> Decline to self-identify (target the group containing "Asian")
const raceFix=await t.evaluate(()=>{
  const lab=e=>{let l=''; if(e.id){const x=document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if(x)l=x.innerText;} return (l||e.closest('label')?.innerText||'').replace(/\s+/g,' ').trim();};
  const asian=Array.from(document.querySelectorAll('input[type=radio]')).find(e=>/^Asian \(Not Hispanic/i.test(lab(e)));
  if(!asian) return 'asian radio not found';
  const grp=asian.name;
  const dec=Array.from(document.querySelectorAll(`input[type=radio][name="${CSS.escape(grp)}"]`)).find(e=>/decline to self-identify/i.test(lab(e)));
  if(!dec) return 'no decline option in race group';
  return JSON.stringify({group:grp, asianChecked:asian.checked, declineId:dec.id});
});
console.log('race group:', raceFix);
const parsed=(()=>{try{return JSON.parse(raceFix)}catch{return null}})();
if(parsed?.declineId){
  await t.locator(`#${CSS.escape? parsed.declineId : parsed.declineId}`).check({force:true,timeout:8000})
    .then(()=>console.log('race -> Decline to self-identify OK'))
    .catch(e=>console.log('race check failed:', e.message.slice(0,60)));
}

// 3) resume override + 4) transcript upload
for(const f of await t.locator('input[type=file]').all()){
  const l=await f.evaluate(e=>{let s=''; if(e.id){const x=document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if(x)s=x.innerText;} return (s||e.closest('label')?.innerText||e.name||'').replace(/\s+/g,' ').trim().slice(0,50);});
  if(/transcript/i.test(l)){ await f.setInputFiles(process.env.HOME+'/.jobagent/transcript.pdf').then(()=>console.log('transcript uploaded OK')).catch(e=>console.log('transcript fail:',e.message.slice(0,50))); }
  else if(/resume/i.test(l)){ await f.setInputFiles(process.env.HOME+'/.jobagent/resume.pdf').then(()=>console.log('resume overridden OK')).catch(e=>console.log('resume fail:',e.message.slice(0,50))); }
}
await b.close();
