import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/jobs\/info/.test(x.url()));
await p.bringToFront();
const full=await p.evaluate(()=>{
  const m=document.querySelector('.ant-modal,[role=dialog]');
  let t='';
  m.querySelectorAll('[class*=gh-autofill-popup-field]').forEach(f=>{
    const sel=f.querySelector('.ant-select');
    if(sel&&!sel.querySelector('.ant-select-selection-item')) t=(f.innerText||'').replace(/\s+/g,' ').trim();
  });
  return t;
});
console.log('FULL LABEL:', full);
// open the empty select to read its options
const opened=await p.evaluate(()=>{
  const m=document.querySelector('.ant-modal,[role=dialog]');
  for(const f of m.querySelectorAll('[class*=gh-autofill-popup-field]')){
    const sel=f.querySelector('.ant-select');
    if(sel&&!sel.querySelector('.ant-select-selection-item')){
      sel.querySelector('.ant-select-selector')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
      return true;
    }
  }
  return false;
});
await p.waitForTimeout(1800);
const opts=await p.evaluate(()=>[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content')].map(e=>(e.innerText||'').trim()).slice(0,14));
console.log('opened:', opened, '| options:', JSON.stringify(opts));
await b.close();
