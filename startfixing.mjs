import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
await p.bringToFront();
const full=await p.evaluate(()=>{
  const bs=[...document.querySelectorAll('[class*=job-agent-bubble]')];
  return (bs[bs.length-1].innerText||'').replace(/\s+/g,' ');
});
console.log('=== ACTIVE JOB PANEL ==='); console.log(full.slice(0,700));
const beforeTabs=c.pages().length;
const fix=p.locator('button:has-text("Start Fixing")').first();
console.log('\nStart Fixing count:', await fix.count());
await fix.click({timeout:8000}).then(()=>console.log('clicked Start Fixing')).catch(e=>console.log('err:',e.message.slice(0,60)));
await p.waitForTimeout(7000);
console.log('new tabs:', c.pages().length-beforeTabs);
c.pages().forEach(x=>console.log('  tab:',x.url().slice(0,95)));
await b.close();
