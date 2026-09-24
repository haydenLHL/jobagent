import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
for(const pg of c.pages()) if(/jobs\/info/.test(pg.url())) await pg.close().catch(()=>{});
const p=c.pages().find(x=>/minisites/.test(x.url()));
const r=await p.evaluate(()=>{
  const html=document.documentElement.outerHTML;
  const ids=[...new Set((html.match(/[0-9a-f]{24}/g)||[]))];
  const hrefs=[...document.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')).filter(h=>/jobs\/info/.test(h||''));
  const dataAttrs=[];
  document.querySelectorAll('[data-job-id],[data-id],[data-row-key]').forEach(e=>{
    dataAttrs.push(e.getAttribute('data-job-id')||e.getAttribute('data-id')||e.getAttribute('data-row-key'));
  });
  return {idsInHtml:ids.length, idSample:ids.slice(0,5), hrefs:hrefs.length, dataAttrs:[...new Set(dataAttrs)].slice(0,6)};
});
console.log('24-hex ids in HTML:', r.idsInHtml, r.idSample);
console.log('jobs/info hrefs:', r.hrefs);
console.log('data attrs:', JSON.stringify(r.dataAttrs));
await b.close();
