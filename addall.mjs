import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
await p.bringToFront();
for(let round=1; round<=5; round++){
  const st=await p.evaluate(()=>{
    const m=(document.body.innerText||'').match(/(\d+)\s+Jobs?\s+Added/i);
    return m?Number(m[1]):0;
  });
  console.log(`round ${round}: queue=${st}`);
  if(st>=40){ console.log('hit 40 cap'); break; }
  const addAll=p.locator('button:has-text("Add All")').first();
  if(await addAll.count().catch(()=>0)){
    await addAll.click({timeout:8000}).then(()=>console.log('  clicked Add All')).catch(e=>console.log('  err:',e.message.slice(0,45)));
    await p.waitForTimeout(6000);
  } else {
    const more=p.locator('button:has-text("Show Me More Matches")').first();
    if(await more.count().catch(()=>0)){ await more.click({timeout:8000}).catch(()=>{}); console.log('  requested more matches'); await p.waitForTimeout(10000); }
    else { console.log('  no Add All / More buttons'); break; }
  }
}
const fin=await p.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').slice(0,150));
console.log('final:', fin);
await b.close();
