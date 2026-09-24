import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const pop=c.pages().find(x=>/tesla\.com/.test(x.url()));
if(!pop){ console.log('no tesla tab found'); await b.close(); process.exit(0); }
await pop.bringToFront();
const before=await pop.evaluate(()=>document.querySelectorAll('input,select,textarea').length);
console.log('inputs before Apply:', before);
const url0=pop.url();
await pop.locator('button:has-text("Apply"), a:has-text("Apply")').first().click({timeout:10000}).catch(e=>console.log('apply click err:',e.message.slice(0,50)));
await pop.waitForTimeout(5000);
console.log('url changed:', pop.url()!==url0, '| new url:', pop.url().slice(0,110));
console.log('frames:', pop.frames().length);
for(const f of pop.frames()){
  const n=await f.evaluate(()=>document.querySelectorAll('input,select,textarea').length).catch(()=>-1);
  if(n>0) console.log('  frame', f.url().slice(0,90), 'inputs:', n);
}
const after=await pop.evaluate(()=>document.querySelectorAll('input,select,textarea').length);
console.log('inputs on main frame after Apply:', after);
const pw=await pop.evaluate(()=>document.querySelectorAll('input[type=password]').length);
console.log('password fields:', pw);
const multiStep=await pop.evaluate(()=>{
  const txt=(document.body.innerText||'');
  return /step\s*\d\s*of\s*\d|page\s*\d\s*of\s*\d|next\s*step|continue to next/i.test(txt);
});
console.log('multi-step indicator found:', multiStep);
await b.close();
