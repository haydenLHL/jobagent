import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
await p.bringToFront();
const beforeTabs=c.pages().length;
await p.locator('button:has-text("View All")').first().click({timeout:8000})
  .then(()=>console.log('clicked View All')).catch(e=>console.log('err:',e.message.slice(0,50)));
await p.waitForTimeout(6000);
console.log('new tabs:', c.pages().length-beforeTabs);
const r=await p.evaluate(()=>{
  const modal=document.querySelector('.ant-modal,.ant-drawer,[role=dialog]');
  const bs=[...document.querySelectorAll('button')].map(x=>(x.innerText||'').trim()).filter(t=>t&&t.length<35);
  return {url:location.href, modal: modal?(modal.innerText||'').replace(/\s+/g,' ').slice(0,350):null,
          uniqBtns:[...new Set(bs)].slice(0,18)};
});
console.log('url:', r.url);
console.log('modal/drawer:', r.modal);
console.log('buttons:', JSON.stringify(r.uniqBtns));
await b.close();
