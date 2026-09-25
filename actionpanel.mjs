import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
await p.bringToFront();
const r=await p.evaluate(()=>{
  const txt=(document.body.innerText||'').replace(/\s+/g,' ');
  const idx=txt.indexOf('Action Required');
  const bs=[...document.querySelectorAll('button,a,[role=button]')]
    .map(e=>({t:(e.innerText||'').replace(/\s+/g,' ').trim(), cls:(e.className||'').toString().slice(0,45)}))
    .filter(x=>x.t && x.t.length<45);
  return {snippet: idx>=0? txt.slice(Math.max(0,idx-250), idx+500) : txt.slice(0,400), buttons: bs};
});
console.log('--- panel text ---'); console.log(r.snippet);
console.log('--- all buttons ---'); r.buttons.forEach(x=>console.log(`  "${x.t}"  [${x.cls}]`));
await b.close();
