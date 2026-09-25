import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
const r=await p.evaluate(()=>{
  const presets=[...document.querySelectorAll('[class*=preset]')].map(e=>(e.innerText||'').replace(/\s+/g,' ').trim()).filter(Boolean);
  const chat=document.querySelector('textarea');
  const viewAll=[...document.querySelectorAll('button')].filter(x=>/View All/i.test(x.innerText||'')).length;
  return {presets:[...new Set(presets)].slice(0,10), chatPlaceholder: chat?chat.placeholder:null, viewAllCount:viewAll};
});
console.log('presets:', JSON.stringify(r.presets,null,1));
console.log('chat placeholder:', r.chatPlaceholder);
console.log('View All buttons:', r.viewAllCount);
await b.close();
