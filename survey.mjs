import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const c = b.contexts()[0];
const p = await c.newPage();
try {
  await p.goto('https://jobright.ai/jobs/recommend',{waitUntil:'domcontentloaded',timeout:45000});
  await p.waitForTimeout(6000);
  // scroll to load more cards
  for (let i=0;i<4;i++){ await p.mouse.wheel(0,4000); await p.waitForTimeout(1200); }
  const data = await p.evaluate(() => {
    const out=[];
    document.querySelectorAll('a[href]').forEach(a=>{
      const h=a.getAttribute('href')||'';
      if(/jobs\/info|job-detail|\/job\//.test(h)) out.push({href:h, txt:(a.innerText||'').replace(/\s+/g,' ').slice(0,70)});
    });
    return {links:out.slice(0,40), total:out.length, bodyLen:document.body.innerText.length};
  });
  console.log('job detail links found:', data.total);
  data.links.slice(0,15).forEach(l=>console.log('  ', l.href.slice(0,60), '|', l.txt));
} finally { await p.close(); await b.close(); }
