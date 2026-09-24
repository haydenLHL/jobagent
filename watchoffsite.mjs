import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
console.log('watching for new tabs for 90s...');
const seen=new Set(c.pages().map(p=>p.url()));
const t0=Date.now();
while(Date.now()-t0<90000){
  await new Promise(r=>setTimeout(r,2000));
  for(const p of c.pages()){
    const u=p.url();
    if(!seen.has(u)){
      seen.add(u);
      console.log(`[${Math.round((Date.now()-t0)/1000)}s] NEW TAB: ${u.slice(0,110)}`);
      if(!/jobright\.ai/.test(u)){
        console.log('  -> OFFSITE. Closing per instruction.');
        await p.close().catch(e=>console.log('  close err:',e.message.slice(0,50)));
      }
    }
  }
}
console.log('watch window done');
const ap=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
if(ap) console.log('final agent state:', await ap.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').slice(0,150)).catch(()=>'ERR'));
await b.close();
