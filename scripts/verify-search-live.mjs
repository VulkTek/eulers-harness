// Live Ctrl+F verify over CDP: opens overlay via real keydown, types real queries
// through the renderer, checks empty-state, hits, and click-through session jump.
// Usage: node scripts/verify-search-live.mjs [port]
const port = Number(process.argv[2] || 9555)

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } }
await new Promise(r => { ws.onopen = r })
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async (expr, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true })
  if (r.exceptionDetails) throw new Error('renderer error: ' + JSON.stringify(r.exceptionDetails).slice(0, 500))
  return r.result.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const type = (q) => `(function(){
  const i = document.getElementById('euler-search-input');
  if (!i) return 'NoSearchInput';
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(i, ${JSON.stringify(q)});
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`

// 1) Ctrl+F opens the overlay via a real keydown
const opened = await evalJs(`(function(){
  const before = !!document.querySelector('.search-overlay');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
  return { before, after: !!document.querySelector('.search-overlay') };
})()`)
console.log('ctrl+F overlay:', JSON.stringify(opened))
if (!opened.after) { console.log('FAIL: overlay did not open'); process.exit(1) }

// 2) empty query: clean "no matches" state (not zero silent hits)
await evalJs(type('zzqqxxqqq'))
await sleep(1600)
const emptyState = await evalJs(`(function(){
  return { hits: document.querySelectorAll('.search-hit').length,
           empty: document.querySelector('.search-empty')?.textContent ?? null };
})()`)
console.log('nonsense query:', JSON.stringify(emptyState))

// 3) real query: hits must appear with session name + content
await evalJs(type('evening'))
await sleep(1800)
const hits = await evalJs(`(function(){
  return Array.from(document.querySelectorAll('.search-hit')).map(h => ({
    session: h.querySelector('.sh-session')?.textContent ?? '',
    content: (h.querySelector('.sh-content')?.textContent ?? '').slice(0, 80)
  }));
})()`)
console.log('query "evening" hits:', hits.length, JSON.stringify(hits.slice(0, 3), null, 0))
if (hits.length === 0) { console.log('FAIL: no hits for a term that exists'); process.exit(1) }

// 4) click through: overlay must close and the session content must render
const activeBefore = await evalJs('document.querySelector(".session-item.active, .sidebar [class*=active]")?.textContent ?? "unknown"')
await evalJs(`document.querySelector('.search-hit').click()`)
await sleep(2200)
const after = await evalJs(`(function(){
  return { overlayClosed: !document.querySelector('.search-overlay'),
           bodyHasHit: /good evening/i.test(document.body.textContent),
           sidebar: document.querySelector(".session-item.active, .sidebar [class*=active]")?.textContent ?? activeBefore };
})()`.replaceAll('activeBefore', JSON.stringify(activeBefore)))
console.log('after click:', JSON.stringify(after))
if (after.overlayClosed && after.bodyHasHit) {
  console.log('PASS: Ctrl+F search + click-through jump verified live')
  process.exit(0)
}
console.log('FAIL')
process.exit(1)
