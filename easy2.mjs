import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/jobs\/info/.test(x.url()));
if(!p){console.log('no tab');await b.close();process.exit(0)}
await p.bringToFront();
const r=await p.evaluate(()=>{
  const m=document.querySelector('.ant-modal,[role=dialog]'); if(!m)return{err:'no modal'};
  const flds=[];
  m.querySelectorAll('input,select,textarea').forEach(e=>{
    const ty=(e.type||e.tagName).toLowerCase();
    let l=''; if(e.id){const x=document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if(x)l=x.innerText;}
    l=(l||e.closest('label')?.innerText||e.getAttribute('aria-label')||e.placeholder||e.name||'').replace(/\s+/g,' ').trim().slice(0,44);
    if(ty==='checkbox'||ty==='radio'){ if(e.checked)flds.push(`[${ty}] ${l} = CHECKED`); return; }
    flds.push(`[${ty}] ${l} = ${String(e.value||'').slice(0,32)||'(EMPTY)'}`);
  });
  const txt=(m.innerText||'').replace(/\s+/g,' ');
  const acts=[]; m.querySelectorAll('button').forEach(e=>{const s=(e.innerText||'').replace(/\s+/g,' ').trim(); if(/submit|apply|autofill|start|continue|next|confirm/i.test(s)&&s.length<34)acts.push(s);});
  return {flds:flds.slice(0,26), acts:[...new Set(acts)], tail:txt.slice(-320)};
});
console.log('--- fields ---'); (r.flds||[]).forEach(x=>console.log('  ',x));
console.log('--- action buttons ---', JSON.stringify(r.acts));
console.log('--- modal tail ---', r.tail);
await b.close();
