// Diagnose model-step Next: hook window errors, real CDP mouse click on button coords.
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

// install error hook
await evalJs(`window.__errs = []; window.addEventListener('error', e => window.__errs.push('window.onerror: ' + (e.message || e) + ' @' + (e.filename || '') + ':' + (e.lineno || 0))); 'hooked'`)

// get coords of model-step Next
const box = await evalJs(`(function(){
  const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Next' && x.closest('.wizard'));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, disabled: b.disabled };
})()`)
console.log('button box:', JSON.stringify(box))
if (!box) { console.log('no button'); process.exit(1) }

// real mouse click
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
await new Promise(r => setTimeout(r, 500))
const after = await evalJs(`JSON.stringify({
  labels: Array.from(document.querySelectorAll('.wizard-label')).map(l => l.textContent),
  errs: window.__errs,
  hasWorkspace: document.body.textContent.includes('Workspace folder')
})`)
console.log('after real click:', after)
process.exit(0)
