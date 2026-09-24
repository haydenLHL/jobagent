import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()) && !x.isClosed());
const body=await p.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').slice(0,250)).catch(e=>'ERR');
console.log('main agent tab state:', body);
console.log('all tabs now:');
c.pages().forEach(x=>console.log('  ', x.url().slice(0,90)));
await b.close();
