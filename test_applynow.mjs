import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
await p.bringToFront();
// start the queue so a job reaches an Action Required handoff
const go=p.locator('button:has-text("Start"), button:has-text("Continue")').first();
if(await go.count().catch(()=>0)){ await go.click({timeout:8000}).catch(()=>{}); console.log('started queue'); }
// wait for an Action Required panel with Apply Now
for(let i=0;i<30;i++){
  await p.waitForTimeout(4000);
  const st=await p.evaluate(()=>{
    const bs=[...document.querySelectorAll('[class*=job-agent-bubble]')];
    for(let k=bs.length-1;k>=0 && k>bs.length-4;k--){
      const t=(bs[k].innerText||'').replace(/\s+/g,' ');
      if(/Action Required/i.test(t)){
        const btns=[...bs[k].querySelectorAll('button')].map(x=>(x.innerText||'').trim()).filter(Boolean);
        return {found:true, txt:t.slice(0,220), btns, idx:k};
      }
    }
    return {found:false};
  }).catch(()=>({found:false}));
  if(st.found){
    console.log(`\n[t+${i*4}s] ACTION REQUIRED: ${st.txt}`);
    console.log('buttons:', JSON.stringify(st.btns));
    const beforeTabs=c.pages().length;
    const clicked=await p.evaluate(idx=>{
      const bs=[...document.querySelectorAll('[class*=job-agent-bubble]')];
      const t=[...bs[idx].querySelectorAll('button')].find(x=>/^Apply Now$/i.test((x.innerText||'').trim()));
      if(t){ t.click(); return true; } return false;
    }, st.idx).catch(()=>false);
    console.log('Apply Now clicked:', clicked);
    await p.waitForTimeout(9000);
    console.log('tabs before:', beforeTabs, '-> after:', c.pages().length);
    c.pages().forEach(x=>console.log('   tab:', x.url().slice(0,95)));
    break;
  }
  if(i%5===4) console.log(`  [t+${i*4}s] waiting for Action Required...`);
}
await b.close();
