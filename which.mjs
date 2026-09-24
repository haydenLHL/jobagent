import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const ash=c.pages().filter(x=>/ashbyhq/.test(x.url()));
console.log('ashby tabs:', ash.length);
for(const [i,t] of ash.entries()){
  console.log(`\n--- tab ${i}: ${t.url().slice(0,90)}`);
  console.log('  frames:', t.frames().length);
  for(const f of t.frames()){
    const n=await f.evaluate(()=>{
      let filled=0,empty=0;
      document.querySelectorAll('input,textarea,select').forEach(e=>{
        const ty=(e.type||e.tagName).toLowerCase();
        if(['hidden','submit','button'].includes(ty))return;
        if(ty==='checkbox'||ty==='radio'){ if(e.checked)filled++; return; }
        String(e.value||'').trim()?filled++:empty++;
      });
      return {filled,empty,url:location.href.slice(0,60)};
    }).catch(()=>null);
    if(n&&(n.filled||n.empty)) console.log(`    frame ${n.url} filled=${n.filled} empty=${n.empty}`);
  }
}
await b.close();
