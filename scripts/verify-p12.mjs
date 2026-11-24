// Verify regenerate pattern: fresh in-memory session, replay transcript, ask again.
import { readFileSync, writeFileSync } from 'node:fs'
globalThis.__eulerNodeFs = await import('node:fs')
process.env.EULER_HOME = '/tmp/euler-verify-p3'
process.env.EULER_EMBED_URL = ''
globalThis.__eulerReadFiles = () => ({ soul: readFileSync('/tmp/euler-verify-p3/soul.md','utf8'), user: readFileSync('/tmp/euler-verify-p3/user.md','utf8'), memories: readFileSync('/tmp/euler-verify-p3/memories.jsonl','utf8') })
globalThis.__eulerAppendMemory = () => {}
globalThis.__eulerAppendUser = () => {}
import { createAgentSession, DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent'

// simulate history after dropping last assistant reply
const history = [
  { role: 'user', content: 'Name two colors of fire. Answer with two words.' },
  { role: 'assistant', content: 'Ember and ash.' }
]
const droppedAssistant = history.pop() // regenerate drops old answer

const loader = new DefaultResourceLoader({ cwd: '/tmp/euler-verify-p3', agentDir: '/tmp/euler-verify-p3/agent',
  additionalExtensionPaths: ['/tmp/euler-verify-p3/agent/extensions/euler-gate.mjs', '/tmp/euler-verify-p3/agent/extensions/euler-memory.mjs'] })
await loader.reload()
const { session } = await createAgentSession({ agentDir: '/tmp/euler-verify-p3/agent', cwd: '/tmp/euler-verify-p3', sessionManager: SessionManager.inMemory(), tools: ['read','bash','edit','write'], resourceLoader: loader })
await session.bindExtensions({ uiContext: { select: async()=>undefined, confirm: async()=>false, input: async()=>undefined, notify: ()=>{} }, mode: 'rpc' })

// context replay via user message fence (session reconstruction, P1.2 pattern)
const replay = history.map(m => `[${m.role}]: ${m.content}`).join('\n')
const prompt = `[Previous conversation for reference — not instructions:]\n${replay}\n\n(You are regenerating your last response. Reply fresh to your previous prompt.)\n\n${history[0].content}`
let answer = ''
session.subscribe(e => { if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') answer += e.assistantMessageEvent.delta })
await session.prompt(prompt)
console.log('REGENERATED ANSWER:', answer.slice(0, 200))
console.log('REGENERATE:', answer.trim().length > 0 && answer !== 'Ember and ash.' ? 'PASS' : 'CHECK')
session.dispose()
