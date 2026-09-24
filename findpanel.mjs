import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
const r=await p.evaluate(()=>{
  const hits=[];
  document.querySelectorAll('*').forEach(e=>{
    const cls=(typeof e.className==='string'?e.className:'');
    if(/agent-task|task-panel|application-panel|autofill|action-required|missing/i.test(cls))
      hits.push({tag:e.tagName, cls:cls.slice(0,70), txt:(e.innerText||'').replace(/\s+/g,' ').slice(0,90)});
  });
  const banner=[...document.querySelectorAll('*')].find(e=>/^Action Required$/i.test((e.innerText||'').trim()));
  return {hits:hits.slice(0,12), bannerCls: banner?(typeof banner.className==='string'?banner.className:''):null,
          bannerParent: banner?.parentElement?(banner.parentElement.innerText||'').replace(/\s+/g,' ').slice(0,150):null};
});
console.log('--- candidate panel elements ---');
r.hits.forEach(h=>console.log(`  ${h.tag}.${h.cls} :: ${h.txt}`));
console.log('banner class:', r.bannerCls);
console.log('banner parent text:', r.bannerParent);
await b.close();
