// Two screenshots: (1) header with enlarged cog, (2) wizard endpoint step with Ollama API section.
import { writeFileSync } from 'fs'
const port = 9555
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } }
await new Promise(r => { ws.onopen = r })
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value
const snap = (path) => new Promise(async res => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path, Buffer.from(r.data, 'base64'))
  console.log('saved', path)
  res()
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

await sleep(800)
await snap('/tmp/euler-gear.png')
// open wizard, straight to endpoint step
await evalJs(`document.querySelector('button[title="Settings"]').click()`)
await sleep(400)
await evalJs(`Array.from(document.querySelectorAll('.wizard-next')).find(b => b.textContent.trim() === 'Next').click()`)
await sleep(500)
await snap('/tmp/euler-ollama-section.png')
// leave it closed, clean state
await evalJs(`document.querySelector('.wizard-close').click()`)
await sleep(200)
process.exit(0)
