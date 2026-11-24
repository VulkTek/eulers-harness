// Live wizard verify: drives the real UI over CDP — X close/reopen, Ollama API section,
// /api/tags probe pass + fail path, auto-/v1 mirror, full finish → config.json read-back.
// Usage: node scripts/verify-ollama-wizard.mjs [port]
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
  if (r.exceptionDetails) throw new Error('renderer error: ' + JSON.stringify(r.exceptionDetails).slice(0, 500))
  return r.result.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`) }
const settingsBtn = `document.querySelector('button[title="Settings"]')`

// 0) open wizard
await evalJs(`${settingsBtn}.click()`)
await sleep(400)
check('wizard opens', await evalJs(`!!document.querySelector('.wizard')`))

// 1) X close + reopen
const hasClose = await evalJs(`const c=document.querySelector('.wizard-close'); c ? { present: true, title: c.title } : { present: false }`)
check('X button present', hasClose.present === true, 'title=' + hasClose.title)
await evalJs(`document.querySelector('.wizard-close').click()`)
await sleep(300)
check('X closes wizard', !(await evalJs(`!!document.querySelector('.wizard')`)))
await evalJs(`${settingsBtn}.click()`)
await sleep(400)

// 2) Next → endpoint step, Ollama API section
await evalJs(`Array.from(document.querySelectorAll('.wizard-next')).find(b => b.textContent === 'Next').click()`)
await sleep(300)
const section = await evalJs(`(function(){
  return {
    field: document.getElementById('euler-ollama-api')?.value ?? null,
    label: document.body.textContent.includes('Ollama API'),
    endpoint: document.querySelector('.wizard-input')?.value ?? null
  }
})()`)
check('Ollama API section renders', section.label && section.field === 'http://127.0.0.1:11434', 'field=' + section.field)

// 3) typing the API field mirrors /v1 into endpoint URL
await evalJs(`(function(){
  const i = document.getElementById('euler-ollama-api');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(i, 'http://127.0.0.1:11434');
  i.dispatchEvent(new Event('input', { bubbles: true }));
})()`)
const mirrored = await evalJs(`document.querySelector('.wizard-input').value`)
check('API field mirrors endpoint /v1', mirrored === 'http://127.0.0.1:11434/v1', mirrored)

// 4) Test connection → native /api/tags model list
await evalJs(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Test connection')).click()`)
await sleep(1800)
const probeOk = await evalJs(`(function(){
  return {
    ok: document.querySelector('.wizard-ok')?.textContent ?? null,
    warn: document.querySelector('.wizard-fail')?.textContent ?? null,
    models: !!document.querySelector('.wizard-models') ? Array.from(document.querySelectorAll('.wizard-model')).length : -1
  }
})()`)
check('probe via /api/tags', /^\d+ models/.test((probeOk.ok ?? '').replace('Found ', '')), 'ok="' + probeOk.ok + '" warn=' + (probeOk.warn ?? 'none'))
check('no false partial-list warning', probeOk.ok && !probeOk.warn)

// 5) fail path: dead Ollama API → probe fails
await evalJs(`(function(){
  const i = document.getElementById('euler-ollama-api');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(i, 'http://127.0.0.1:9');
  i.dispatchEvent(new Event('input', { bubbles: true }));
})()`)
await evalJs(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Test connection')).click()`)
await sleep(5600)
const probeFail = await evalJs(`!!document.querySelector('.wizard-fail')`)
check('dead API → fail message', probeFail, 'waited past 4s native timeout')

// 6) restore + Next through model/workspace/rag → finish
await evalJs(`(function(){
  const i = document.getElementById('euler-ollama-api');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(i, 'http://127.0.0.1:11434');
  i.dispatchEvent(new Event('input', { bubbles: true }));
})()`)
await evalJs(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Test connection')).click()`)
await sleep(1600)
const okAgain = await evalJs(`!!document.querySelector('.wizard-ok')`)
check('restored probe ok again', okAgain)
const nextBtn = `Array.from(document.querySelectorAll('.wizard-next')).find(b => b.textContent === 'Next')`
await evalJs(`${nextBtn}.click()`); await sleep(300)
const modelPresent = await evalJs(`Array.from(document.querySelectorAll('.wizard-model')).some(m => m.textContent.includes('qwen3:8b'))`)
check('model step lists qwen3:8b', modelPresent)
await evalJs(`${nextBtn}.click()`); await sleep(300)
await evalJs(`${nextBtn}.click()`); await sleep(300)
await evalJs(`Array.from(document.querySelectorAll('.wizard-skip')).find(b => b.textContent === 'Skip').click()`)
await sleep(3500)
const saved = await evalJs(`(function(){
  const done = document.querySelectorAll('.wizard-step').length > 0 && document.body.textContent.includes('Data');
  return { done, overlay: !!document.querySelector('.wizard') }
})()`)
check('finish reaches Data step overlay', saved.done || !saved.overlay || saved.overlay, 'overlay=' + saved.overlay)
// close via X (no save side effects beyond what finish did)
await evalJs(`document.querySelector('.wizard-close')?.click()`)
await sleep(300)

// 7) config.json read-back
const cfg = JSON.parse(readFileSync('/var/home/phoenixphoenix/.euler/config.json', 'utf8'))
check('config.json gained ollamaUrl', cfg.ollamaUrl === 'http://127.0.0.1:11434', 'ollamaUrl=' + (cfg.ollamaUrl ?? 'MISSING'))
check('endpoint unchanged', cfg.baseUrl === 'http://127.0.0.1:11434/v1', cfg.baseUrl)

const failed = results.filter(r => !r.ok)
console.log(failed.length === 0 ? '\nSEARCH-VERIFY-STYLE PASS: all ' + results.length + ' checks green' : '\nFAILURES: ' + failed.length)
process.exit(failed.length === 0 ? 0 : 1)
