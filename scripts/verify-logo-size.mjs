// Verify doubled header logo: rendered height 68px, header row 84px, no clipping; screenshot.
import { writeFileSync } from 'fs'
const port = Number(process.argv[2] || 9555)
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } }
await new Promise(r => { ws.onopen = r })
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = expr => new Promise(async res => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  res(r.result?.value)
})
await new Promise(r => setTimeout(r, 5000))
const dims = await evalJs(`(function(){
  const img = document.querySelector('.header img.logo');
  const header = document.querySelector('.header');
  const ir = img.getBoundingClientRect(); const hr = header.getBoundingClientRect();
  return JSON.stringify({ logoRect: { h: Math.round(ir.height), w: Math.round(ir.width), top: Math.round(ir.top) }, headerH: Math.round(hr.height), natural: img.naturalWidth + 'x' + img.naturalHeight, clipped: ir.height > hr.height });
})()`)
console.log('dims:', dims)
await (async () => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync('/tmp/euler-logo-double.png', Buffer.from(r.data, 'base64'))
  console.log('saved /tmp/euler-logo-double.png')
})()
const d = JSON.parse(dims)
console.log(d.logoRect.h === 68 && !d.clipped ? 'PASS: logo at 68px inside unclipped header' : 'FAIL')
process.exit(d.logoRect.h === 68 && !d.clipped ? 0 : 1)
