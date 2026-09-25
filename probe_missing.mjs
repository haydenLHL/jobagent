import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const p=c.pages().find(x=>/jobright\.ai\/agent/.test(x.url()));
const r=await p.evaluate(()=>{
  const bs=[...document.querySelectorAll('[class*=job-agent-bubble]')];
  // find most recent bubble mentioning required-fields
  for(let k=bs.length-1;k>=0;k--){
    const t=(bs[k].innerText||'').replace(/\s+/g,' ');
    if(/required fields filled/i.test(t)){
      return {idx:k, txt:t.slice(0,420),
        btns:[...bs[k].querySelectorAll('button')].map(x=>({t:(x.innerText||'').trim(), w:x.offsetWidth})),
        links:[...bs[k].querySelectorAll('a[href]')].map(a=>a.getAttribute('href')).slice(0,5)};
    }
  }
  return null;
});
if(!r){ console.log('no missing-fields bubble found'); }
else {
  console.log('bubble idx:', r.idx);
  console.log('text:', r.txt);
  console.log('buttons:', JSON.stringify(r.btns));
  console.log('links:', JSON.stringify(r.links));
}
await b.close();
