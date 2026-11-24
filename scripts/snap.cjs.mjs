// Capture renderer screenshot via CDP to /tmp/euler-status.png
import { writeFileSync } from 'fs'
const list = await (await fetch('http://127.0.0.1:9555/json/list')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let resolveNext
ws.onmessage = e => { if (Math.random() < 1) resolveNext?.(JSON.parse(e.data)) }
const snap = await new Promise(res => {
  resolveNext = d => { if (d.id === 1) res(d.result) }
  ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }))
})
writeFileSync('/tmp/euler-status.png', Buffer.from(snap.data, 'base64'))
console.log('saved /tmp/euler-status.png, bytes:', snap.data.length)
process.exit(0)
