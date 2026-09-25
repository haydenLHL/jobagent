import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/intern-list/.test(x.url())) || await c.newPage();
if(!/intern-list/.test(p.url())) await p.goto('https://www.intern-list.com/',{waitUntil:'domcontentloaded',timeout:35000});
await p.waitForTimeout(6000);
console.log('frames:', p.frames().length);
for(const f of p.frames()){
  const info=await f.evaluate(()=>{
    const applies=[...document.querySelectorAll('*')].filter(e=>/^(👉\s*)?Apply$/i.test((e.innerText||'').trim()) && e.children.length<=1);
    return {url:location.href.slice(0,90), inputs:document.querySelectorAll('input').length,
            applies:applies.length,
            applyTag: applies[0]?applies[0].tagName+'.'+(typeof applies[0].className==='string'?applies[0].className:'').slice(0,40):null,
            applyHref: applies[0]?(applies[0].getAttribute('href')||applies[0].closest('a')?.getAttribute('href')||''):null,
            bodyLen:(document.body?document.body.innerText.length:0)};
  }).catch(e=>({err:e.message.slice(0,50)}));
  console.log(' ', JSON.stringify(info));
}
await b.close();
