import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
console.log('all open tabs:');
c.pages().forEach((x,i)=>console.log(`  [${i}] ${x.url().slice(0,110)}`));
const agentTabs=c.pages().filter(x=>/jobright\.ai\/agent/.test(x.url()));
for(const p of agentTabs){
  const body=await p.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').slice(0,150)).catch(()=>'ERR');
  console.log('  agent tab state:', body);
}
await b.close();
