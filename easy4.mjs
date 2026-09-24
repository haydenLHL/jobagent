import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/jobs\/info/.test(x.url()));
await p.bringToFront();
const r=await p.evaluate(()=>{
  const m=document.querySelector('.ant-modal,[role=dialog]');
  const out=[];
  m.querySelectorAll('input,select,textarea').forEach(e=>{
    const ty=(e.type||e.tagName).toLowerCase();
    if(['hidden','submit','button'].includes(ty))return;
    const v=(ty==='checkbox'||ty==='radio')?(e.checked?'CHECKED':''):String(e.value||'').trim();
    if(v)return;
    const item=e.closest('.ant-form-item')||e.parentElement?.parentElement;
    let lab=(item?.querySelector('label')?.innerText||'').replace(/\s+/g,' ').trim();
    if(!lab){ // walk back for nearest preceding text
      let n=e, hop=0;
      while(n&&!lab&&hop++<5){ n=n.parentElement; const t=(n?.innerText||'').replace(/\s+/g,' ').trim(); if(t&&t.length<60)lab=t; }
    }
    const req=(item?.className||'').includes('required')|| /\*/.test(lab) || e.required;
    out.push(`${req?'*':' '}[${ty}] ${lab.slice(0,50)}`);
  });
  return out;
});
console.log(`empty fields (${r.length}):`);
r.forEach(x=>console.log('  ',x));
await b.close();
