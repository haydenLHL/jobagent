import { chromium } from 'playwright-core';
const cnt=p=>p.evaluate(()=>{const m=document.querySelector('.ant-modal,[role=dialog]');if(!m)return null;
  let f=0,e=0,re=[];
  m.querySelectorAll('input,select,textarea').forEach(x=>{const ty=(x.type||x.tagName).toLowerCase();
    if(['hidden','submit','button'].includes(ty))return;
    if(ty==='checkbox'||ty==='radio'){if(x.checked)f++;return;}
    if(String(x.value||'').trim())f++;else{e++;}});
  return {f,e};});
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/jobs\/info/.test(x.url()));
await p.bringToFront();
console.log('before:', JSON.stringify(await cnt(p)));
const btn=p.locator('button:has-text("Start to Autofill")').first();
console.log('btn count:', await btn.count());
await btn.click({timeout:10000}).then(()=>console.log('clicked Start to Autofill')).catch(e=>console.log('err:',e.message.slice(0,55)));
for(let i=1;i<=5;i++){ await p.waitForTimeout(4000); console.log(`  t+${i*4}s`, JSON.stringify(await cnt(p))); }
const st=await p.evaluate(()=>{const m=document.querySelector('.ant-modal,[role=dialog]');
  return {txt:(m?.innerText||'').replace(/\s+/g,' ').slice(0,200), cap:!!document.querySelector('iframe[src*=recaptcha]')};});
console.log('modal head:', st.txt);
console.log('captcha on page:', st.cap);
await b.close();
