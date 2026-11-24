// Logo verify: header logo loads (naturalWidth), wizard logo loads, screenshot both.
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
const evalJs = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('renderer error: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const snap = async path => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path, Buffer.from(r.data, 'base64')); console.log('saved', path) }

await sleep(5000)
const header = await evalJs(`(function(){
  const img = document.querySelector('img.logo');
  if (!img) return { present: false };
  return { present: true, natural: img.naturalWidth + 'x' + img.naturalHeight, src: img.src.slice(-40), complete: img.complete };
})()`)
console.log('header logo:', JSON.stringify(header))
if (!(header.present && header.natural.startsWith('5'))) { console.log('FAIL: header logo broken'); process.exit(1) }

// wizard logo
await evalJs(`document.querySelector('button[title="Settings"]').click()`)
await sleep(500)
const wiz = await evalJs(`(function(){
  const w = document.querySelector('.wizard');
  const img = w?.querySelector('img');
  if (!img) return { present: false };
  return { present: true, natural: img.naturalWidth + 'x' + img.naturalHeight, src: img.src.slice(-40) };
})()`)
console.log('wizard logo:', JSON.stringify(wiz))
await snap('/tmp/euler-logo-wizard.png')
await evalJs(`document.querySelector('.wizard-close').click()`)
await sleep(200)
await snap('/tmp/euler-logo-header.png')

const ok = header.natural.startsWith('5') && wiz.present && wiz.natural.startsWith('4')
console.log(ok ? 'LOGO PASS: both images render at native size' : 'LOGO FAIL')
process.exit(ok ? 0 : 1)
