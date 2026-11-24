// Live model-menu verify: chip click opens menu; ollama group + fake-vllm group both render
// with sizes/labels; clicking a model row switches session; screenshot for the record.
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
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`) }
const snap = async path => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path, Buffer.from(r.data, 'base64')); console.log('saved', path) }

await sleep(6000)

// chip -> menu
const chip = await evalJs(`(function(){
  const c = document.querySelector('.model-chip');
  const r = c.getBoundingClientRect();
  return { text: c.textContent.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2, cur: c.style.cursor || getComputedStyle(c).cursor };
})()`)
check('chip clickable + labeled', /·/.test(chip.text) && (chip.cur === 'pointer'), chip.text + ' cursor=' + chip.cur)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: chip.x, y: chip.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: chip.x, y: chip.y, button: 'left', clickCount: 1 })
await sleep(2200)
const menu = await evalJs(`(function(){
  const menu = document.querySelector('.model-menu');
  if (!menu) return null;
  return {
    groups: Array.from(menu.querySelectorAll('.mm-source')).map(s => s.textContent.trim()),
    models: Array.from(menu.querySelectorAll('.mm-model')).map(m => m.textContent.trim().replace(/\\s+/g, ' '))
  };
})()`)
check('menu opens', !!menu)
check('ollama group present', (menu.groups ?? []).some(g => g.startsWith('ollama ·')), JSON.stringify(menu.groups ?? []))
check('vllm group present (stand-in server)', (menu.groups ?? []).some(g => g.startsWith('vllm ·')), '')
const ollamaRows = (menu.models ?? []).filter(m => /qwen3:8b|nomic-embed/.test(m))
check('ollama models with sizes', ollamaRows.length >= 2 && /GB/.test(ollamaRows.join(' ')), JSON.stringify(ollamaRows))
check('vllm models listed', (menu.models ?? []).some(m => m.includes('Qwen2.5-7B-Instruct-vLLM-TEST')), '')
await snap('/tmp/euler-model-menu.png')

// click the current model row (safe switch path: same model, full session rebuild)
const current = await evalJs(`Array.from(document.querySelectorAll('.mm-model')).find(m => m.classList.contains('current'))?.textContent.trim() || null`)
console.log('current row:', current)
if (current) {
  await evalJs(`Array.from(document.querySelectorAll('.mm-model')).find(m => m.classList.contains('current')).click()`)
  await sleep(6000)
  const after = await evalJs(`(function(){
    return { chip: document.querySelector('.model-chip')?.textContent.trim(), menu: !!document.querySelector('.model-menu'), toast: document.querySelector('.toast')?.textContent ?? '' };
  })()`)
  check('switch completes, menu closes', !after.menu && /\d/.test(after.chip), 'chip=' + after.chip + ' toast="' + after.toast + '"')
} else {
  check('switch completes', false, 'no current row?')
}
const failed = results.filter(r => !r.ok)
console.log(failed.length === 0 ? '\nALL MODEL-MENU CHECKS PASS (' + results.length + ')' : '\nFAILURES: ' + failed.length)
process.exit(failed.length === 0 ? 0 : 1)
