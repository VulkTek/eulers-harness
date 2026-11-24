// Continuation: from model step → workspace → rag skip → finish → Data → X close → config read-back.
import { readFileSync } from 'fs'
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
  if (r.exceptionDetails) throw new Error('renderer error: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const labels = async () => evalJs(`JSON.stringify(Array.from(document.querySelectorAll('.wizard-label')).map(l => l.textContent))`)
const clickByText = (txt) => `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(txt)})?.click(); 'clicked-or-missing'`

console.log('labels before:', await labels())
const r1 = await evalJs(clickByText('Next'))  // model → workspace
await sleep(400)
console.log('after 1st Next:', await labels(), '|', r1)
const r2 = await evalJs(clickByText('Next'))  // workspace → rag
await sleep(400)
console.log('after 2nd Next:', await labels(), '|', r2)
await evalJs(clickByText('Skip'))             // finish (skipRag)
await sleep(4200)                             // pihost re-init + session rebuild
console.log('after finish:', await labels())
const doneState = await evalJs(`(function(){
  const labels = Array.from(document.querySelectorAll('.wizard-label')).map(l => l.textContent);
  return { labels, overlay: !!document.querySelector('.wizard'), dataExport: !!Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Export all data')) }
})()`)
console.log('done state:', JSON.stringify(doneState))
await evalJs(clickByText('Done'))
await sleep(400)
const closed = !(await evalJs(`!!document.querySelector('.wizard')`))
console.log(' wizard closed via Done:', closed)
const cfg = JSON.parse(readFileSync('/var/home/phoenixphoenix/.euler/config.json', 'utf8'))
console.log('config.json:', JSON.stringify({ provider: cfg.provider, baseUrl: cfg.baseUrl, modelId: cfg.modelId, ollamaUrl: cfg.ollamaUrl ?? 'MISSING', contextLimit: cfg.contextLimit }))
const ok = cfg.ollamaUrl === 'http://127.0.0.1:11434' && cfg.baseUrl === 'http://127.0.0.1:11434/v1' && cfg.modelId === 'qwen3:8b' && closed
console.log(ok ? 'CONTINUATION PASS: finish saved ollamaUrl, config intact' : 'CONTINUATION FAIL')
process.exit(ok ? 0 : 1)
