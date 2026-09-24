const list = await (await fetch('http://localhost:9222/json/list')).json();
const tab = list.find(t => t.type === 'page' && t.url.includes('/jobs/recommend'));
if (!tab) { console.log('NO_TAB'); process.exit(0); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
const done = new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error('WS_TIMEOUT')), 25000);
  ws.onopen = () => ws.send(JSON.stringify({
    id: 1, method: 'Runtime.evaluate',
    params: { expression: 'document.body.innerText.slice(0,260)', returnByValue: true },
  }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id === 1) { clearTimeout(to); res(m.result?.result?.value ?? JSON.stringify(m)); }
  };
  ws.onerror = (e) => { clearTimeout(to); rej(new Error('WS_ERR')); };
});
console.log('=== RESULT ===');
console.log(await done);
ws.close();
