import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
console.log('all tabs:');
c.pages().forEach(x=>console.log('  ', x.url().slice(0,100)));
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
if(p){
  const body=await p.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').slice(0,300)).catch(e=>'ERR:'+e.message);
  console.log('agent tab body:', body);
}
await b.close();
