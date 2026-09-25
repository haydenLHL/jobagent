import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const t=c.pages().filter(x=>/jobright\.ai\/jobs\/info/.test(x.url()))[0];
if(!t){console.log('no jobright detail tab');await b.close();process.exit(0)}
await t.bringToFront(); await t.waitForTimeout(2000);
const r=await t.evaluate(()=>{
  const btns=[];
  document.querySelectorAll('button,[role=button],a,div[class*=btn]').forEach(e=>{
    const s=(e.innerText||'').replace(/\s+/g,' ').trim();
    if(s && s.length<45 && /appl|yes|no|did you|confirm|mark|status|track/i.test(s)) btns.push(`${e.tagName}: "${s}"`);
  });
  const modal=document.querySelector('.ant-modal, [role=dialog]');
  return {btns:[...new Set(btns)].slice(0,18), modal: modal?(modal.innerText||'').replace(/\s+/g,' ').slice(0,220):null};
});
console.log('modal:', r.modal);
console.log('--- apply/status controls on detail page ---');
r.btns.forEach(x=>console.log('  ',x));
await b.close();
