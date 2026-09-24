import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
const r=await p.evaluate(()=>{
  const W=innerWidth;
  // any container living on the right half with form fields inside
  const cands=[];
  document.querySelectorAll('div,section,aside,form').forEach(e=>{
    const b=e.getBoundingClientRect();
    if(b.width<200||b.height<150) return;
    if(b.left < W*0.45) return;                       // right side only
    const n=e.querySelectorAll('input,select,textarea').length;
    if(n>0) cands.push({cls:(typeof e.className==='string'?e.className:'').slice(0,55),
      left:Math.round(b.left), w:Math.round(b.width), h:Math.round(b.height), inputs:n,
      txt:(e.innerText||'').replace(/\s+/g,' ').slice(0,90)});
  });
  // dedupe by smallest container per input count
  cands.sort((a,x)=>a.inputs-x.inputs || a.h-x.h);
  return {W, cands:cands.slice(0,8), totalInputs:document.querySelectorAll('input,select,textarea').length};
});
console.log('viewport width:', r.W, '| total inputs on page:', r.totalInputs);
r.cands.forEach(x=>console.log(`  left=${x.left} ${x.w}x${x.h} inputs=${x.inputs} .${x.cls}\n      "${x.txt}"`));
if(!r.cands.length) console.log('  no right-side container with inputs');
await b.close();
