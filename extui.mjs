import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const t=c.pages().filter(x=>/ashbyhq/.test(x.url()))[0];
const r=await t.evaluate(()=>{
  // explicit read of the required fields
  const grab=(sel)=>{const e=document.querySelector(sel);return e?`"${e.value}"`:'(no el)';};
  const named={};
  document.querySelectorAll('input').forEach(e=>{
    let lab=''; if(e.id){const l=document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if(l)lab=l.innerText.trim();}
    if(/name|email|linkedin/i.test(lab)) named[lab.slice(0,30)]=`"${e.value}"`;
  });
  // injected extension DOM / shadow roots
  const inj=[];
  document.querySelectorAll('body > *').forEach(e=>{
    const id=e.id||'', cls=(typeof e.className==='string'?e.className:'');
    if(/jobright|jr-|autofill|extension/i.test(id+' '+cls) || e.shadowRoot)
      inj.push(`${e.tagName}#${id}.${cls.slice(0,40)}${e.shadowRoot?' [SHADOW]':''}`);
  });
  return {named, inj, bodyKids:document.body.children.length};
});
console.log('required field values:', JSON.stringify(r.named,null,1));
console.log('injected/shadow elements:', r.inj.length);
r.inj.forEach(x=>console.log('  ',x));
await b.close();
