import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const t=c.pages().find(x=>!/jobright\.ai/.test(x.url()));
if(!t){console.log('no ATS tab'); await b.close(); process.exit(0);}
const r=await t.evaluate(()=>{
  const ifr=[...document.querySelectorAll('iframe')].map(f=>({src:(f.src||'').slice(0,110), w:f.offsetWidth, h:f.offsetHeight, vis:getComputedStyle(f).visibility}));
  const badge=!!document.querySelector('.grecaptcha-badge');
  const anchor=ifr.filter(f=>/recaptcha.*anchor/i.test(f.src));
  const bframe=ifr.filter(f=>/recaptcha.*bframe/i.test(f.src));
  const gdiv=[...document.querySelectorAll('.g-recaptcha,[data-sitekey]')].map(e=>({cls:(e.className||'').toString().slice(0,40), w:e.offsetWidth, h:e.offsetHeight}));
  return {iframes:ifr.filter(f=>/recaptcha|hcaptcha/i.test(f.src)), badge, anchorCount:anchor.length, anchorVisible:anchor.filter(f=>f.w>0&&f.h>0).length, bframeCount:bframe.length, gdiv};
});
console.log(JSON.stringify(r,null,1));
await b.close();
