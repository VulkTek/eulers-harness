// Dump live wizard DOM: current step + all buttons + inputs.
const port = Number(process.argv[2] || 9555)
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } }
await new Promise(r => { ws.onopen = r })
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const r = await send('Runtime.evaluate', { expression: `(function(){
  const wiz = document.querySelector('.wizard');
  return JSON.stringify({
    overlay: !!wiz,
    labels: Array.from(document.querySelectorAll('.wizard-label')).map(l => l.textContent),
    buttons: Array.from(document.querySelectorAll('.wizard > button, .wizard-btns button, .wizard-next, .wizard-back, .wizard-skip, .wizard-rag-actions button')).map(b => ({ cls: b.className, text: b.textContent.trim(), disabled: b.disabled })),
    models: Array.from(document.querySelectorAll('.wizard-model')).length,
    modelSelected: document.querySelector('.wizard-model.selected')?.textContent ?? null
  });
})()`, returnByValue: true })
console.log(r.result.value)
process.exit(0)
