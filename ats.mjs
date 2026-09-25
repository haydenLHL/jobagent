import { chromium } from 'playwright-core';
const IDS=['6aa4924f8275e3a211760d71','6aa44feec1928370a285d783','6aa4dc99930bff471a29be60','6aa45803f7baf881567ce618','6aa4dd59a77a53f5a156e681','6aa480ce422289703bd66d84','6aa4988a1d92e2d05d1156e6','6aa4c42882e82a31997ba9f9'];
const classify=u=>{
  if(!u) return 'unknown';
  if(/myworkdayjobs|myworkdaysite|wd\d+\.myworkday/i.test(u)) return 'WORKDAY(skip)';
  if(/greenhouse\.io|boards\.greenhouse/i.test(u)) return 'greenhouse';
  if(/lever\.co/i.test(u)) return 'lever';
  if(/ashbyhq\.com/i.test(u)) return 'ashby';
  if(/icims\.com/i.test(u)) return 'iCIMS';
  if(/taleo\.net/i.test(u)) return 'taleo';
  if(/smartrecruiters/i.test(u)) return 'smartrecruiters';
  if(/jobvite/i.test(u)) return 'jobvite';
  if(/workable/i.test(u)) return 'workable';
  return 'other';
};
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
const c=b.contexts()[0]; const p=await c.newPage();
try{
 for(const id of IDS){
  await p.goto(`https://jobright.ai/jobs/info/${id}`,{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
  await p.waitForTimeout(3500);
  const r=await p.evaluate(()=>{
    const t=document.title.replace(' | Jobright.ai','').slice(0,62);
    let orig='';
    document.querySelectorAll('a[href]').forEach(a=>{
      const h=a.getAttribute('href')||'';
      if(/^https?:/.test(h) && !/jobright/i.test(h) && !orig &&
         /apply|job|career|greenhouse|lever|ashby|workday|icims/i.test(h)) orig=h;
    });
    const auto=!!Array.from(document.querySelectorAll('button')).find(x=>/AUTOFILL/i.test(x.innerText||''));
    return {t,orig,auto};
  });
  console.log(`${classify(r.orig).padEnd(15)} autofill=${r.auto?'Y':'N'}  ${r.t}`);
  console.log(`                 ${r.orig.slice(0,88)||'(no external link found)'}`);
 }
} finally { await p.close(); await b.close(); }
