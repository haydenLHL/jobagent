import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://jobright.ai/jobs/applied',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(6000);
await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
const r=await p.evaluate(()=>{
  const txt=(document.body.innerText||'').replace(/\s+/g,' ');
  const m=txt.match(/Applied\((\d+)\)/)||txt.match(/Applied\s+(\d+)/);
  // top of the applied list = most recent
  return {count:m?m[1]:'?', head:txt.slice(txt.indexOf('Applied('), txt.indexOf('Applied(')+520)};
});
console.log('APPLIED TOTAL:', r.count, '(was 1619 at session start)');
console.log('--- most recent entries ---');
console.log(r.head);
await p.close(); await b.close();
