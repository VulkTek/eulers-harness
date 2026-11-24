// One-shot: call the app's live search IPC directly and see what it returns (error vs empty).
const port = Number(process.argv[2] || 9555)
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } }
await new Promise(r => { ws.onopen = r })
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) return { threw: r.exceptionDetails };
  return r.result.value
}
const direct = await evalJs(`window.api.search('evening').then(v => ({ ok: true, n: v.length, first: v[0] ?? null }),
  err => ({ ok: false, err: String(err).slice(0, 300) }))`)
console.log('direct search:', JSON.stringify(direct, null, 1).slice(0, 600))
const dbCounts = await evalJs(`(async () => {
  // renderer has no db access; just confirm IPC liveness
  const m = await window.api.metrics(); return { model: m.modelId, tokens: m.totalTokens }
})()`)
console.log('app alive:', JSON.stringify(dbCounts))
process.exit(0)
