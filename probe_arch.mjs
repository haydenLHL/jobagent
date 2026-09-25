import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
if(!p){console.log('no agent tab'); await b.close(); process.exit(0);}
const r=await p.evaluate(()=>{
  const header=(document.body.innerText||'').replace(/\s+/g,' ').slice(0,120);
  const bs=[...document.querySelectorAll('[class*=job-agent-bubble]')];
  const last=bs.length?bs[bs.length-1]:null;
  // where does "Remove & Continue" live - global or per-job?
  const allRemove=[...document.querySelectorAll('button')].filter(x=>/Remove & Continue/i.test(x.innerText||''));
  const inBubble = last? [...last.querySelectorAll('button')].map(x=>(x.innerText||'').trim()).filter(Boolean) : [];
  return {header, bubbleCount:bs.length,
    lastBubble: last?(last.innerText||'').replace(/\s+/g,' ').slice(0,200):null,
    bubbleButtons:inBubble,
    removeCount: allRemove.length,
    removeInBubble: last? allRemove.some(x=>last.contains(x)) : false};
});
console.log('header:', r.header);
console.log('bubbles:', r.bubbleCount);
console.log('last bubble:', r.lastBubble);
console.log('bubble buttons:', JSON.stringify(r.bubbleButtons));
console.log('"Remove & Continue" count on page:', r.removeCount, '| inside active bubble:', r.removeInBubble);
await b.close();
