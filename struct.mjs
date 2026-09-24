import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/jobs\/info/.test(x.url()));
const r=await p.evaluate(()=>{
  const m=document.querySelector('.ant-modal,[role=dialog]');
  const out=[];
  // sample: the Gender select and a text input
  const sels=[...m.querySelectorAll('.ant-select')].slice(0,2);
  sels.forEach((s,i)=>{
    const item=s.querySelector('.ant-select-selection-item');
    const ph=s.querySelector('.ant-select-selection-placeholder');
    out.push(`SELECT[${i}] itemText="${(item?.innerText||'').trim().slice(0,30)}" placeholder="${(ph?.innerText||'').trim().slice(0,24)}"`);
    let n=s,chain=[];
    for(let k=0;k<4&&n;k++){ n=n.parentElement; chain.push(`${n?.tagName}.${(typeof n?.className==='string'?n.className:'').slice(0,38)}`); }
    out.push('   ancestors: '+chain.join(' < '));
  });
  out.push(`total .ant-select: ${m.querySelectorAll('.ant-select').length}`);
  out.push(`with selection-item: ${m.querySelectorAll('.ant-select-selection-item').length}`);
  out.push(`with placeholder: ${m.querySelectorAll('.ant-select-selection-placeholder').length}`);
  const labs=[...m.querySelectorAll('label')].map(l=>(l.innerText||'').replace(/\s+/g,' ').trim()).filter(Boolean).slice(0,12);
  out.push('labels: '+JSON.stringify(labs));
  return out;
});
r.forEach(x=>console.log(x));
await b.close();
