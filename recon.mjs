import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const c = b.contexts()[0];
const p = await c.newPage();
try {
  await p.goto('https://jobright.ai/jobs/info/6aa4924f8275e3a211760d71',{waitUntil:'domcontentloaded',timeout:45000});
  await p.waitForTimeout(6000);
  const info = await p.evaluate(() => {
    const btns=[];
    document.querySelectorAll('button, a[role=button], a').forEach(el=>{
      const t=(el.innerText||'').replace(/\s+/g,' ').trim();
      if(/apply|autofill/i.test(t) && t.length<40)
        btns.push({tag:el.tagName, txt:t, href:el.getAttribute('href')||''});
    });
    return {
      title: document.title.slice(0,80),
      head: document.body.innerText.replace(/\s+/g,' ').slice(0,260),
      applyish: btns.slice(0,10)
    };
  });
  console.log('title:', info.title);
  console.log('--- head ---'); console.log(info.head);
  console.log('--- apply-ish controls ---');
  info.applyish.forEach(x=>console.log(`   [${x.tag}] "${x.txt}" href=${x.href.slice(0,60)}`));
} finally { await p.close(); await b.close(); }
