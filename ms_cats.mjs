import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/minisites/.test(x.url()));
const r=await p.evaluate(()=>{
  const links=[...document.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')).filter(h=>/minisites-jobs/.test(h||''));
  return [...new Set(links)].slice(0,30);
});
console.log('category URLs found:', r.length);
r.forEach(x=>console.log('  ',x));
await b.close();
