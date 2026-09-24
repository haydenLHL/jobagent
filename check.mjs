import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
const c = b.contexts()[0];
// extensions show up as service worker / background targets
const sws = c.serviceWorkers ? c.serviceWorkers().map(w=>w.url()) : [];
console.log('service workers:', sws.length);
sws.forEach(u=>console.log('  ', u.slice(0,95)));
const p = c.pages()[0] || await c.newPage();
await p.goto('https://jobright.ai/jobs/recommend', {waitUntil:'domcontentloaded', timeout:45000}).catch(e=>console.log('nav:', e.message.slice(0,80)));
await p.waitForTimeout(4000);
console.log('url:', p.url().slice(0,110));
console.log('title:', (await p.title()).slice(0,80));
const txt = (await p.innerText('body').catch(()=>'')).slice(0,400);
console.log('--- body head ---'); console.log(txt);
await b.close();
