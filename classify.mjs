import { chromium } from 'playwright-core';
import fs from 'fs';
const jobs=JSON.parse(fs.readFileSync('jobs.json','utf8'));
const done=fs.existsSync('classify.jsonl')?new Set(fs.readFileSync('classify.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l).id)):new Set();
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
let n=0;
for(const j of jobs){
  n++;
  if(done.has(j.id)) continue;
  const rec={id:j.id,title:j.txt.slice(0,58)};
  let p=null;
  try{
    p=await c.newPage();
    await p.goto(`https://jobright.ai/jobs/info/${j.id}`,{waitUntil:'domcontentloaded',timeout:22000});
    await p.waitForTimeout(3200);
    await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
    const r=await p.evaluate(()=>{
      const bs=[...document.querySelectorAll('button')].map(e=>(e.innerText||'').replace(/\s+/g,' ').trim());
      let orig='';
      document.querySelectorAll('a[href^="http"]').forEach(a=>{const h=a.getAttribute('href');
        if(!orig&&!/jobright/i.test(h)&&/apply|job|career|greenhouse|lever|ashby|icims|workable|smartrecruiters|myworkday/i.test(h))orig=h;});
      return {easy:bs.some(x=>/EASY APPLY/i.test(x)), auto:bs.some(x=>/APPLY WITH AUTOFILL/i.test(x)),
              ext:bs.some(x=>/APPLY NOW|APPLY EXTERNALLY/i.test(x)), title:document.title.replace(' | Jobright.ai','').slice(0,62), orig};
    });
    rec.company=r.title; rec.orig=r.orig.slice(0,110);
    rec.path = r.easy?'EASY-APPLY' : r.auto?'AUTOFILL' : r.ext?'EXTERNAL' : 'NONE';
    if(/myworkdayjobs|myworkdaysite/i.test(r.orig)) rec.path='WORKDAY';
  }catch(e){ rec.path='err'; rec.e=String(e.message).slice(0,40); }
  try{ if(p&&!p.isClosed())await p.close(); }catch{}
  fs.appendFileSync('classify.jsonl',JSON.stringify(rec)+'\n');
  if(n%25===0) console.log(`[${n}/${jobs.length}] ...`);
}
console.log('CLASSIFY DONE');
await b.close();
