import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
const c = b.contexts()[0];
console.log('existing tabs (untouched):');
c.pages().forEach(x=>console.log('   ', x.url().slice(0,88)));
const p = await c.newPage();            // fresh tab, leaves your tabs alone
try {
  await p.goto('https://jobright.ai/jobs/recommend',{waitUntil:'domcontentloaded',timeout:45000});
  await p.waitForTimeout(5000);
  const body = (await p.innerText('body').catch(()=>'')) || '';
  console.log('landed:', p.url().slice(0,95));
  console.log('SIGN IN present:', /SIGN IN|JOIN NOW/i.test(body));
  const cards = await p.locator('[class*=job], [data-testid*=job]').count().catch(()=>0);
  console.log('job-ish elements:', cards);
  console.log('--- body head ---');
  console.log(body.slice(0,300));
} finally { await p.close(); await b.close(); }
