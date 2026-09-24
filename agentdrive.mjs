import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0];
const DUR=Number(process.env.DUR||600)*1000;
const t0=Date.now();
let skipped=0, submitted=0, lastState='';

const agent=()=>c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()) && !x.isClosed());

while(Date.now()-t0<DUR){
  // 1) close any offsite tab immediately - user instruction: never work offsite
  for(const p of c.pages()){
    const u=p.url();
    if(u && !/jobright\.ai/.test(u) && !/^about:/.test(u)){
      console.log(`[${Math.round((Date.now()-t0)/1000)}s] offsite tab -> closing: ${u.slice(0,80)}`);
      await p.close().catch(()=>{});
    }
  }
  const p=agent();
  if(!p){ console.log('agent tab gone'); break; }

  const st=await p.evaluate(()=>{
    const txt=(document.body.innerText||'').replace(/\s+/g,' ');
    return {
      actionRequired: /Action Required/i.test(txt),
      offsiteOnly: /autofill only on the application site/i.test(txt),
      header: (txt.match(/(Standby|Executing|Paused|Completed)[^.]*\./)||[])[0]||'',
      submittedMsg: (txt.match(/Application submitted for [^@]*@\s*\S+/)||[])[0]||'',
    };
  }).catch(()=>null);
  if(!st){ await new Promise(r=>setTimeout(r,3000)); continue; }

  if(st.header && st.header!==lastState){ console.log(`[${Math.round((Date.now()-t0)/1000)}s] ${st.header}`); lastState=st.header; }

  // 2) offsite-only job -> Skip (never try to fill it offsite)
  if(st.actionRequired && st.offsiteOnly){
    const clicked=await p.evaluate(()=>{
      const bs=[...document.querySelectorAll('button')];
      const applied=bs.find(x=>/I.{0,3}ve Applied/i.test(x.innerText||''));
      // the Skip that belongs to this action panel sits just before "I've Applied."
      let target=null;
      if(applied){
        const all=bs.filter(x=>/^Skip$/i.test((x.innerText||'').trim()));
        target=all.length?all[all.length-1]:null;
      }
      if(target){ target.click(); return true; }
      return false;
    }).catch(()=>false);
    if(clicked){ skipped++; console.log(`  -> SKIPPED offsite-only job (#${skipped})`); await new Promise(r=>setTimeout(r,6000)); continue; }
  }

  // 3) resume/paused -> keep it moving
  if(/Paused|Standby/i.test(st.header)){
    const go=p.locator('button:has-text("Continue"), button:has-text("Start")').first();
    if(await go.count().catch(()=>0)){ await go.click({timeout:6000}).catch(()=>{}); console.log('  -> resumed'); await new Promise(r=>setTimeout(r,6000)); continue; }
  }

  if(st.submittedMsg) console.log('  ::', st.submittedMsg.slice(0,90));
  await new Promise(r=>setTimeout(r,4000));
}
console.log(`\nwatch ended. offsite-only skipped=${skipped}`);
const p=agent();
if(p) console.log('final state:', await p.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').slice(0,120)).catch(()=>'ERR'));
