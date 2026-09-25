import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const t=c.pages().filter(x=>/ashbyhq/.test(x.url()))[0];
for(const s of await t.locator('select').all()){
  const v=await s.inputValue().catch(()=>'');
  const opts=await s.locator('option').evaluateAll(o=>o.map(x=>x.value).filter(Boolean));
  if(v==='2026' && opts.includes('2027') && !opts.includes('2028')){
    await s.selectOption('2027');
    console.log('education end year: 2026 -> ' + await s.inputValue());
  }
}
const st=await t.evaluate(()=>Array.from(document.querySelectorAll('select')).map(s=>s.value).join(' | '));
console.log('all selects now:', st);
await b.close();
