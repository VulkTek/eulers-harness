import { readFileSync } from 'node:fs'
globalThis.__eulerNodeFs = await import('node:fs')
process.env.EULER_HOME = '/tmp/euler-verify-p3'
process.env.EULER_EMBED_URL = 'http://127.0.0.1:11434/v1'
import { createAgentSession, DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent'
const loader = new DefaultResourceLoader({ cwd: '/tmp/euler-verify-p3', agentDir: '/tmp/euler-verify-p3/agent',
  additionalExtensionPaths: ['/tmp/euler-verify-p3/agent/extensions/euler-gate.mjs', '/tmp/euler-verify-p3/agent/extensions/euler-memory.mjs', '/tmp/euler-verify-p3/agent/extensions/euler-rag.mjs'] })
await loader.reload()
const { session } = await createAgentSession({ agentDir: '/tmp/euler-verify-p3/agent', cwd: '/tmp/euler-verify-p3', sessionManager: SessionManager.inMemory(), tools: ['read','bash','edit','write','search_docs'], resourceLoader: loader })
await session.bindExtensions({ uiContext: { select: async()=>undefined, confirm: async()=>false, input: async()=>undefined, notify: ()=>{} }, mode: 'rpc' })
let answer = ''
let usedTool = false
session.subscribe(e => {
  if (e.type === 'tool_execution_start' && e.toolName === 'search_docs') usedTool = true
  if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') answer += e.assistantMessageEvent.delta
})
await session.prompt('Search my private docs: what port does the WardRyn deployment use on the primary server? Answer with just the port number.')
console.log('used search_docs:', usedTool ? 'PASS' : 'FAIL')
console.log('ANSWER:', answer.slice(0, 300))
console.log('RAG E2E:', answer.includes('8081') ? 'PASS' : 'FAIL')
session.dispose()
