import { readFileSync } from 'node:fs'
globalThis.__eulerReadFiles = () => ({
  soul: readFileSync('/tmp/euler-verify-p3/soul.md', 'utf8'),
  user: readFileSync('/tmp/euler-verify-p3/user.md', 'utf8'),
  memories: ''
})
import { createAgentSession, DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent'
const loader = new DefaultResourceLoader({ cwd: '/tmp/euler-verify-p3', agentDir: '/tmp/euler-verify-p3/agent',
  additionalExtensionPaths: ['/tmp/euler-verify-p3/agent/extensions/euler-gate.mjs', '/tmp/euler-verify-p3/agent/extensions/euler-memory.mjs'] })
await loader.reload()
const { session } = await createAgentSession({ agentDir: '/tmp/euler-verify-p3/agent', cwd: '/tmp/euler-verify-p3', sessionManager: SessionManager.inMemory(), tools: ['read','bash','edit','write'], resourceLoader: loader })
await session.bindExtensions({ uiContext: { select: async()=>undefined, confirm: async()=>false, input: async()=>undefined, notify: ()=>{} }, mode: 'rpc' })
let answer = ''
session.subscribe(e => { if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') answer += e.assistantMessageEvent.delta })
await session.prompt('The word my soul tells me to mention is... what? Answer with just the word.')
console.log('ANSWER:', answer.slice(0, 300))
session.dispose()
