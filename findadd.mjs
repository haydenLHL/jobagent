import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
const r=await p.evaluate(()=>{
  const bs=[...document.querySelectorAll('button,a,[role=button]')]
    .map(e=>({t:(e.innerText||'').replace(/\s+/g,' ').trim(), cls:(typeof e.className==='string'?e.className:'').slice(0,50)}))
    .filter(x=>x.t && x.t.length<40);
  const uniq=[]; const seen=new Set();
  bs.forEach(x=>{ if(!seen.has(x.t)){seen.add(x.t); uniq.push(x);} });
  const addish=uniq.filter(x=>/add|queue|more match|find|search|auto/i.test(x.t));
  return {all:uniq.slice(0,22), addish};
});
console.log('--- add/queue-related controls ---');
r.addish.forEach(x=>console.log(`  "${x.t}"  [${x.cls}]`));
console.log('--- all unique buttons ---');
r.all.forEach(x=>console.log(`  "${x.t}"`));
await b.close();
