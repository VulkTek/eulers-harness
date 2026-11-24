// Live pull verify: cancel path on qwen3:1.7b, then real pull of qwen3:0.6b with progress
// stream capture, then list refresh + /api/tags read-back + screenshot.
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
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`) }
const typeInto = (sel, v) => `(function(){
  const i = document.querySelector(${JSON.stringify(sel)});
  if (!i) return 'missing';
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(i, ${JSON.stringify(v)});
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`

// open wizard → endpoint step
await evalJs(`document.querySelector('button[title="Settings"]').click()`)
await sleep(400)
await evalJs(`Array.from(document.querySelectorAll('.wizard-next')).find(b => b.textContent.trim() === 'Next').click()`)
await sleep(400)
check('pull UI present', !!await evalJs(`document.getElementById('euler-ollama-pull')`))

// 1) cancel path on a bigger model
await evalJs(typeInto('#euler-ollama-pull', 'qwen3:1.7b'))
await evalJs(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Pull').click()`)
await sleep(7000)
const mid = await evalJs(`document.getElementById('euler-ollama-pull-prog')?.textContent ?? 'none'`)
console.log('progress during download:', mid)
check('progress streams %', /\d+%|pulling/i.test(mid))
await evalJs(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Cancel').click()`)
await sleep(1500)
const cancelState = await evalJs(`document.getElementById('euler-ollama-pull-prog')?.textContent ?? 'none'`)
check('cancel works', /cancel/i.test(cancelState), cancelState)

// 2) real pull: qwen3:0.6b
await evalJs(typeInto('#euler-ollama-pull', 'qwen3:0.6b'))
await evalJs(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Pull').click()`)
const seen = new Set()
let finalProg = ''
for (let i = 0; i < 150; i++) {
  await sleep(3000)
  const prog = await evalJs(`document.getElementById('euler-ollama-pull-prog')?.textContent ?? 'none'`)
  if (prog !== finalProg && !seen.has(prog)) { seen.add(prog); console.log('  prog:', prog) }
  finalProg = prog
  if (/^Pulled|Pull failed|Pull cancelled/.test(prog)) break
}
check('pull completes', finalProg === 'Pulled qwen3:0.6b. Model list refreshed.', finalProg)

// 3) list refresh: model step shows the new model
await evalJs(`Array.from(document.querySelectorAll('.wizard-next')).find(b => b.textContent.trim() === 'Next').click()`)
await sleep(400)
const models = await evalJs(`JSON.stringify(Array.from(document.querySelectorAll('.wizard-model')).map(m => m.textContent))`)
check('qwen3:0.6b in model list', models.includes('qwen3:0.6b'), models.slice(0, 160))

// 4) backend truth
const tags = await (await fetch('http://127.0.0.1:11434/api/tags')).json()
const names = tags.models.map(m => m.name)
check('ollama /api/tags has qwen3:0.6b', names.includes('qwen3:0.6b'), JSON.stringify(names))

// screenshot with model list
await snap('/tmp/euler-pull-models.png')

const failed = results.filter(r => !r.ok)
console.log(failed.length === 0 ? '\nALL PULL CHECKS PASS (' + results.length + ')' : '\nFAILURES: ' + failed.length)
process.exit(failed.length === 0 ? 0 : 1)
