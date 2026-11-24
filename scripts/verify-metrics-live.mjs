// Live metrics verify: drives the running app's own IPC over CDP and samples metrics()
// mid-stream and after settle. PASS needs: >=2 mid-stream samples with tokPerSec set,
// and the post-settle window showing tokPerSec + latencyMs non-null.
// Usage: node scripts/verify-metrics-live.mjs [cdpPort]
const port = Number(process.argv[2] || 9555)

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find(t => t.type === 'page' && (t.url.includes('index.html') || t.title !== ''))
if (!page) { console.log('FAIL: no renderer target; targets:', JSON.stringify(list.map(t => ({ type: t.type, url: t.url })))); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
}
await new Promise(res => { ws.onopen = res })
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async (expr, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true })
  if (r.exceptionDetails) throw new Error('renderer error: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result.value
}

await evalJs('window.__eulerSettled = 0; window.api.on("pi:message-end", () => { window.__eulerSettled = Date.now() }); "armed"')
const before = await evalJs('window.api.metrics()')
const t0 = Date.now()
// fire-and-forget: no awaitPromise so the invoke promise doesn't block evaluate
await evalJs('window.api.sendPrompt("In about 100 words, explain the Doppler effect with one everyday example.")', false)

const samples = []
let settledAt = 0
for (let i = 0; i < 300; i++) {
  await new Promise(r => setTimeout(r, 400))
  const s = await evalJs('window.api.metrics()')
  const rel = Date.now() - t0
  samples.push({ rel, tok: s.tokPerSec, lat: s.latencyMs, tokens: s.totalTokens })
  const settled = await evalJs('window.__eulerSettled')
  if (settled > 0) {
    settledAt = rel
    samples.push({ rel: settled, tok: s.tokPerSec, lat: s.latencyMs, tokens: s.totalTokens, settled: true })
    const tail = await evalJs('window.api.metrics()')
    samples.push({ rel: Date.now() - t0, tok: tail.tokPerSec, lat: tail.latencyMs, tokens: tail.totalTokens, tail: true })
    break
  }
}

console.log('metrics before prompt:', JSON.stringify(before))
console.log('--- samples (ms | tok/s | latencyMs | totalTokens) ---')
for (const s of samples) console.log(`${String(s.rel).padStart(6)}ms  tok/s=${String(s.tok).padStart(8)}  lat=${String(s.lat).padStart(8)}  tot=${s.tokens}${s.settled ? '  <-- SETTLED' : ''}${s.tail ? '  (post-settle)' : ''}`)
const midStream = samples.filter(s => !s.settled && !s.tail && s.rel < (settledAt || Infinity))
const midOk = midStream.filter(s => s.tok !== null && s.tok > 0)
const after = samples.filter(s => s.settled || s.tail)
const afterOk = after.length > 0 && after.every(s => s.tok !== null && s.lat !== null)
console.log('--- judge ---')
console.log(`mid-stream samples with tok/s: ${midOk.length}/${midStream.length}`)
console.log(`post-settle tok/s+latency non-null: ${afterOk ? 'YES' : 'NO'}`)
if (midOk.length >= 2 && afterOk) {
  console.log('PASS: live tok/s updates during stream and persists after settle')
  process.exit(0)
}
console.log('FAIL')
process.exit(1)
