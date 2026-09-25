import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
await p.goto('https://www.intern-list.com/',{waitUntil:'domcontentloaded',timeout:35000});
await p.waitForTimeout(7000);
await p.screenshot({path:'' + process.env.HOME + '/.jobagent/il.png'});
console.log('saved il.png');
await b.close();
