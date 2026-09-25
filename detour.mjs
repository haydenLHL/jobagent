import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
try{
 await p.goto('https://jobright.ai/jobs/info/6aa4924f8275e3a211760d71',{waitUntil:'domcontentloaded',timeout:45000});
 await p.waitForTimeout(6000);
 console.log('tour present:', await p.locator('#___reactour').count());
 const exit=p.locator('text=EXIT').first();
 if(await exit.count()){ await exit.click({timeout:8000}).catch(e=>console.log('exit click err:',e.message.slice(0,50))); }
 await p.waitForTimeout(2500);
 // also try escape + direct removal fallback check
 await p.keyboard.press('Escape').catch(()=>{});
 await p.waitForTimeout(1500);
 console.log('tour present after exit:', await p.locator('#___reactour').count());
 const clear=await p.evaluate(()=>{
   const el=Array.from(document.querySelectorAll('button')).find(x=>/AUTOFILL/i.test(x.innerText||''));
   if(!el) return {found:false};
   const r=el.getBoundingClientRect(), top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
   return {found:true, clickable: !!(top&&(el===top||el.contains(top))), topEl: top?top.tagName:'null'};
 });
 console.log('autofill now clickable:', JSON.stringify(clear));
} finally { await p.close(); await b.close(); }
