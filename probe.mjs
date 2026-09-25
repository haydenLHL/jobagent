import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctxs = b.contexts();
console.log('contexts:', ctxs.length);
for (const c of ctxs) {
  for (const p of c.pages()) {
    console.log('  page:', p.url().slice(0,110), '| title:', (await p.title().catch(()=>'?')).slice(0,60));
  }
}
console.log('browser version:', b.version());
await b.close();
