import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://www.intern-list.com/',{waitUntil:'domcontentloaded',timeout:35000});
await p.waitForTimeout(6000);
const r=await p.evaluate(()=>{
  const txt=(document.body.innerText||'').replace(/\s+/g,' ');
  const links=[...document.querySelectorAll('a[href]')].map(a=>({t:(a.innerText||'').replace(/\s+/g,' ').trim().slice(0,30), h:a.getAttribute('href')}));
  const applyish=links.filter(l=>/apply/i.test(l.t)||/apply/i.test(l.h||''));
  const tables=document.querySelectorAll('table').length;
  const rows=document.querySelectorAll('tr').length;
  return {title:document.title, head:txt.slice(0,500), totalLinks:links.length,
          applyCount:applyish.length, applySample:applyish.slice(0,6), tables, rows};
});
console.log('title:', r.title);
console.log('tables:', r.tables, '| rows:', r.rows, '| links:', r.totalLinks, '| apply-links:', r.applyCount);
console.log('apply sample:', JSON.stringify(r.applySample,null,1));
console.log('head:', r.head);
await p.close(); await b.close();
