// Probe: dump real usage shapes from pi SDK events while streaming from ollama.
// Run: PI_CODING_AGENT_DIR=$PWD/.euler-agent node scripts/probe-metrics.mjs
import { createAgentSession, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent'
import { existsSync, readdirSync } from 'fs'

const agentDir = process.env.PI_CODING_AGENT_DIR || '.euler-agent'
const extDir = agentDir + '/extensions'
const extPaths = existsSync(extDir) ? readdirSync(extDir).map(n => extDir + '/' + n) : []
const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir, additionalExtensionPaths: extPaths })
try { await loader.reload() } catch (e) { console.log('loader reload failed (ok, continuing):', String(e).slice(0, 120)) }

const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory(), cwd: process.cwd(), agentDir, resourceLoader: loader })
await session.bindExtensions({ uiContext: {}, mode: 'rpc' })

const out = { deltas: 0, updateUsageShapes: new Set(), endUsage: null, firstDeltaAt: null, lastDeltaAt: null, settledAt: null, updates: 0 }
let t0 = null
session.subscribe(ev => {
  if (ev.type === 'message_update') {
    const ame = ev.assistantMessageEvent
    if (ame?.type === 'text_delta') {
      out.deltas++
      out.lastDeltaAt = Date.now()
      if (!out.firstDeltaAt) out.firstDeltaAt = Date.now()
    }
    out.updates++
    if (ame?.usage && Object.keys(ame.usage).length > 0) {
      out.updateUsageShapes.add(JSON.stringify(ame.usage))
    }
  } else if (ev.type === 'message_end') {
    if (ev.message?.role === 'assistant') {
      out.endUsage = { ts: Date.now() - t0, usage: JSON.parse(JSON.stringify(ev.message.usage ?? null)), stopReason: ev.message.stopReason }
    }
  } else if (ev.type === 'agent_settled') {
    out.settledAt = Date.now()
  }
})
t0 = Date.now()
console.log('model:', session.model?.id, '| provider:', session.model?.provider)
await session.prompt('Reply with exactly this sentence and nothing else: METRICS PROBE OK')

console.log('--- timing (ms from prompt start) ---')
console.log('firstTextDelta:', out.firstDeltaAt ? out.firstDeltaAt - t0 : 'NEVER')
console.log('lastTextDelta:', out.lastDeltaAt ? out.lastDeltaAt - t0 : 'NEVER')
console.log('settled:', out.settledAt ? out.settledAt - t0 : 'NEVER')
console.log('--- deltas ---', out.deltas, 'text deltas over', out.updates, 'message_updates')
console.log('--- message_update usage shapes seen ---')
console.log([...out.updateUsageShapes].join('\n') || '(none)')
console.log('--- message_end assistant usage ---')
console.log(JSON.stringify(out.endUsage, null, 2))
process.exit(0)
