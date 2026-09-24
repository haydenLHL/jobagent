import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const sw=(c.serviceWorkers?c.serviceWorkers():[]).map(w=>w.url());
console.log('extension workers:', sw.length);
sw.forEach(u=>console.log('  ',u.slice(0,80)));
console.log('open tabs:');
c.pages().forEach(p=>console.log('  ',p.url().slice(0,88)));
await b.close();
