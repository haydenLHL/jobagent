import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
await p.bringToFront();
// clear expired-jobs prompt
const rm=p.locator('button:has-text("Remove & Continue")').last();
if(await rm.count().catch(()=>0)){ await rm.click({timeout:8000}).catch(e=>console.log('rm err',e.message.slice(0,40))); console.log('cleared expired-jobs prompt'); await p.waitForTimeout(5000); }
// resume
const go=p.locator('button:has-text("Continue"), button:has-text("Start")').first();
if(await go.count().catch(()=>0)){ await go.click({timeout:8000}).catch(()=>{}); console.log('resumed'); }

for(let i=0;i<28;i++){
  await p.waitForTimeout(4000);
  const st=await p.evaluate(()=>{
    const bs=[...document.querySelectorAll('[class*=job-agent-bubble]')];
    for(let k=bs.length-1;k>=0 && k>bs.length-5;k--){
      const t=(bs[k].innerText||'').replace(/\s+/g,' ');
      if(/Action Required/i.test(t)){
        return {found:true, txt:t.slice(0,240), idx:k,
                btns:[...bs[k].querySelectorAll('button')].map(x=>(x.innerText||'').trim()).filter(Boolean)};
      }
      if(/Have Expired/i.test(t)) return {expired:true, idx:k};
    }
    return {found:false};
  }).catch(()=>({found:false}));
  if(st.expired){
    await p.evaluate(i=>{const bs=[...document.querySelectorAll('[class*=job-agent-bubble]')];
      const t=[...bs[i].querySelectorAll('button')].find(x=>/Remove & Continue/i.test(x.innerText||'')); if(t)t.click();}, st.idx).catch(()=>{});
    console.log('  cleared another expired prompt'); await p.waitForTimeout(5000); continue;
  }
  if(st.found){
    console.log(`\n[t+${i*4}s] ACTION REQUIRED: ${st.txt}`);
    console.log('buttons:', JSON.stringify(st.btns));
    const before=c.pages().length;
    const ok=await p.evaluate(idx=>{
      const bs=[...document.querySelectorAll('[class*=job-agent-bubble]')];
      const t=[...bs[idx].querySelectorAll('button')].find(x=>/^Apply Now$/i.test((x.innerText||'').trim()));
      if(t){ t.click(); return true; } return false;
    }, st.idx).catch(()=>false);
    console.log('Apply Now clicked:', ok);
    await p.waitForTimeout(10000);
    console.log('TABS', before, '->', c.pages().length);
    c.pages().forEach(x=>console.log('   ', x.url().slice(0,100)));
    break;
  }
  if(i%6===5) console.log(`  [t+${i*4}s] waiting...`);
}
await b.close();
