import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
const c = b.contexts()[0];
const p = c.pages()[0] || await c.newPage();
for (const u of ['https://jobright.ai/jobs/recommend','https://jobright.ai/jobs']) {
  await p.goto(u,{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
  await p.waitForTimeout(3500);
  const body = (await p.innerText('body').catch(()=>'')) || '';
  console.log('req:', u);
  console.log('  landed:', p.url().slice(0,90));
  console.log('  has SIGN IN:', /SIGN IN|JOIN NOW/i.test(body));
  console.log('  looks like job list:', /Apply|Match|RECOMMENDED|saved jobs/i.test(body));
}
console.log('--- all tabs ---');
c.pages().forEach(x=>console.log('  ', x.url().slice(0,95)));
await b.close();
