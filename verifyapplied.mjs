import { chromium } from 'playwright-core';
const IDS=['6aa45803f7baf881567ce618','6aa4d98782e82a31997baf9d','6aa204852f936e4a53daf36d'];
const b=await chromium.connectOverCDP('http://localhost:9222');
const c=b.contexts()[0]; const p=await c.newPage();
for(const id of IDS){
  await p.goto(`https://jobright.ai/jobs/info/${id}`,{waitUntil:'domcontentloaded',timeout:25000}).catch(()=>{});
  await p.waitForTimeout(4000);
  await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
  const r=await p.evaluate(()=>{
    const bs=[...document.querySelectorAll('button')].map(e=>(e.innerText||'').replace(/\s+/g,' ').trim()).filter(s=>s&&s.length<30);
    const body=(document.body.innerText||'').replace(/\s+/g,' ');
    const appliedCount=(body.match(/Applied\s+(\d+)/)||[])[1];
    return {title:document.title.replace(' | Jobright.ai','').slice(0,48),
            applied:/APPLIED|You applied|Application submitted/i.test(body),
            btns:[...new Set(bs)].slice(0,6), count:appliedCount};
  });
  console.log(`${r.applied?'MARKED  ':'NOT-MKD '} appliedTotal=${r.count} | ${r.title}`);
  console.log(`   buttons: ${JSON.stringify(r.btns)}`);
}
await p.close(); await b.close();
