import { chromium } from 'playwright-core';
const IDS=['6aa45803f7baf881567ce618','6aa480ce422289703bd66d84','6aa43a20c1928370a285d204'];
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
for(const id of IDS){
  await p.goto(`https://jobright.ai/jobs/info/${id}`,{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  await p.waitForTimeout(5000);
  await p.evaluate(()=>{const t=document.getElementById('___reactour');if(t)t.remove();});
  const r=await p.evaluate(()=>{
    const bs=[];
    document.querySelectorAll('button,a[role=button],div[class*=btn],div[class*=apply]').forEach(e=>{
      const s=(e.innerText||'').replace(/\s+/g,' ').trim();
      if(s&&s.length<40)bs.push(`${e.tagName}:"${s}"`);
    });
    return {title:document.title.replace(' | Jobright.ai','').slice(0,55), bs:[...new Set(bs)].slice(0,14)};
  });
  console.log(`\n${r.title}`);
  r.bs.forEach(x=>console.log('   ',x));
}
await p.close(); await b.close();
