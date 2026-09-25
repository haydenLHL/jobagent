import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
const r=await p.evaluate(()=>{
  const bubbles=[...document.querySelectorAll('[class*=job-agent-bubble]')];
  const last=bubbles[bubbles.length-1];
  const out=bubbles.slice(-3).map(e=>({txt:(e.innerText||'').replace(/\s+/g,' ').slice(0,220),
    inputs:e.querySelectorAll('input,textarea,select').length,
    buttons:[...e.querySelectorAll('button')].map(x=>(x.innerText||'').trim()).filter(Boolean)}));
  return {count:bubbles.length, last3:out};
});
console.log('total bubbles:', r.count);
r.last3.forEach((x,i)=>{
  console.log(`\n--- bubble -${r.last3.length-i} ---`);
  console.log('  text:', x.txt);
  console.log('  inputs:', x.inputs, '| buttons:', JSON.stringify(x.buttons));
});
await b.close();
