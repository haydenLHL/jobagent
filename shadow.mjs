import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0];
const t=c.pages().filter(x=>/ashbyhq/.test(x.url()))[0];
const r=await t.evaluate(()=>{
  const host=document.querySelector('PLASMO-CSUI#jobright-helper-plugin, plasmo-csui#jobright-helper-plugin');
  if(!host) return {err:'host not found'};
  const sr=host.shadowRoot; if(!sr) return {err:'no shadowRoot'};
  const txt=(sr.textContent||'').replace(/\s+/g,' ').trim().slice(0,400);
  const btns=[];
  sr.querySelectorAll('button,[role=button],a,div[class*=btn],span[class*=btn]').forEach(e=>{
    const s=(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
    if(s&&s.length<40) btns.push(`${e.tagName}: "${s}"`);
  });
  const r2=host.getBoundingClientRect();
  return {txt, btns:[...new Set(btns)].slice(0,15), rect:`${Math.round(r2.width)}x${Math.round(r2.height)} @${Math.round(r2.left)},${Math.round(r2.top)}`};
});
console.log(JSON.stringify(r,null,1));
await b.close();
