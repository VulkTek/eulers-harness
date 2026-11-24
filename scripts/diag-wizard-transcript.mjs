// Instrumented fresh wizard drive: real mouse clicks, capture-phase click log, error hooks,
// label assertions after every action. Ground truth for any stalled transition.
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
const sleep = ms => new Promise(r => setTimeout(r, ms))

const armHooks = await evalJs(`(function(){
  window.__errs = []; window.__clicks = [];
  window.addEventListener('error', e => window.__errs.push('onerror: ' + (e.message || e)));
  document.body.addEventListener('click', e => window.__clicks.push((e.target.className || '').toString().slice(0, 24) + ':' + (e.target.textContent || '').trim().slice(0, 12)), true);
  const p = window.onerror ? 'had-onerror' : 'no-before';
  window.onerror = (m, s, l) => { window.__errs.push('onerror: ' + m + ' @' + l); return false }
  return p;
})()`)
console.log('hooks armed:', armHooks)

const labels = () => evalJs(`JSON.stringify(Array.from(document.querySelectorAll('.wizard-label')).map(l => l.textContent))`)
const realClickByText = async (txt) => {
  const box = await evalJs(`(function(){
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === ${JSON.stringify(txt)} && x.closest('.wizard'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, dis: b.disabled };
  })()`)
  if (!box) return { missed: true }
  if (box.dis) return { disabled: true }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return { clicked: true }
}
const state = () => evalJs(`JSON.stringify({ labels: Array.from(document.querySelectorAll('.wizard-label')).map(l => l.textContent), errs: window.__errs, clicks: window.__clicks.slice(-4) })`)

// open wizard
const gear = await evalJs(`(function(){
  const b = document.querySelector('button[title="Settings"]');
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: gear.x, y: gear.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: gear.x, y: gear.y, button: 'left', clickCount: 1 })
await sleep(400)
console.log('after gear:', await labels(), '| overlay:', await evalJs(`!!document.querySelector('.wizard')`))

// provider → endpoint
console.log('click Next:', await realClickByText('Next'))
await sleep(400)
console.log('→ endpoint?', await labels())

// endpoint: Test connection
console.log('click Test:', await realClickByText('Test connection'))
await sleep(1800)
console.log('test state:', await state())

// endpoint → model
console.log('click Next:', await realClickByText('Next'))
await sleep(400)
console.log('→ model?', await labels(), await state())

// model → workspace  (the suspect)
console.log('click Next:', await realClickByText('Next'))
await sleep(500)
console.log('→ workspace?', await labels(), await state())

// workspace → rag
console.log('click Next:', await realClickByText('Next'))
await sleep(400)
console.log('→ rag?', await labels())

// rag skip → finish
console.log('click Skip:', await realClickByText('Skip'))
await sleep(4200)
console.log('→ done?', await labels(), await evalJs(`window.__errs`))

// close
console.log('click ×:', await realClickByText('×'))
await sleep(300)
console.log('overlay now:', await evalJs(`!!document.querySelector('.wizard')`))
process.exit(0)
