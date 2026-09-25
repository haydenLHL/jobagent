import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/jobs\/info/.test(x.url()));
const r=await p.evaluate(()=>{
  const m=document.querySelector('.ant-modal,[role=dialog]');
  const gaps=[];
  m.querySelectorAll('[class*=gh-autofill-popup-field]').forEach(f=>{
    const txt=(f.innerText||'').replace(/\s+/g,' ').trim();
    const sel=f.querySelector('.ant-select');
    if(sel){
      const has=sel.querySelector('.ant-select-selection-item');
      if(!has) gaps.push(`SELECT EMPTY :: ${txt.slice(0,70)}`);
      return;
    }
    const inp=f.querySelector('input,textarea');
    if(inp && !['checkbox','radio'].includes((inp.type||'').toLowerCase()) && !String(inp.value||'').trim())
      gaps.push(`INPUT EMPTY :: ${txt.slice(0,70)}`);
  });
  const cap=!!document.querySelector('iframe[src*=recaptcha],iframe[src*=hcaptcha]');
  const submit=[...m.querySelectorAll('button')].filter(e=>/^submit$/i.test((e.innerText||'').trim())).length;
  return {gaps, cap, submit, fields:m.querySelectorAll('[class*=gh-autofill-popup-field]').length};
});
console.log(`fields: ${r.fields} | gaps: ${r.gaps.length} | captcha: ${r.cap} | submit buttons: ${r.submit}`);
r.gaps.forEach(x=>console.log('  ',x));
await b.close();
