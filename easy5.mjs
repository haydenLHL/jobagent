import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/jobs\/info/.test(x.url()));
await p.bringToFront();
const r=await p.evaluate(()=>{
  const m=document.querySelector('.ant-modal,[role=dialog]');
  const items=[...m.querySelectorAll('.ant-form-item')];
  const empties=[], filled=[];
  items.forEach(it=>{
    const lab=(it.querySelector('label')?.innerText||'').replace(/\s+/g,' ').trim().slice(0,46);
    const req=!!it.querySelector('.ant-form-item-required')|| (it.className||'').includes('required');
    // Ant Select
    const sel=it.querySelector('.ant-select');
    if(sel){
      const v=(sel.querySelector('.ant-select-selection-item')?.innerText||'').trim();
      (v? filled : empties).push(`${req?'*':' '}SELECT ${lab} = ${v||'(placeholder)'}`);
      return;
    }
    const inp=it.querySelector('input,textarea');
    if(!inp)return;
    const ty=(inp.type||'').toLowerCase();
    if(ty==='checkbox'||ty==='radio'){ (inp.checked?filled:empties).push(`${req?'*':' '}${ty.toUpperCase()} ${lab}`); return; }
    const v=String(inp.value||'').trim();
    (v?filled:empties).push(`${req?'*':' '}${ty||'text'} ${lab} = ${v||'(EMPTY)'}`);
  });
  return {n:items.length, empties, filledN:filled.length,
    reqEmpty:empties.filter(x=>x.startsWith('*'))};
});
console.log(`form items: ${r.n} | filled: ${r.filledN} | empty: ${r.empties.length}`);
console.log(`\n--- REQUIRED & EMPTY (${r.reqEmpty.length}) ---`);
r.reqEmpty.forEach(x=>console.log('  ',x));
console.log(`\n--- all empty (${r.empties.length}) ---`);
r.empties.slice(0,14).forEach(x=>console.log('  ',x));
await b.close();
