import { readFileSync } from 'node:fs'
// bind appends
const appendLog = []
globalThis.__eulerReadFiles = () => ({
  soul: readFileSync('/tmp/euler-verify-p3/soul.md', 'utf8'),
  user: readFileSync('/tmp/euler-verify-p3/user.md', 'utf8'),
  memories: readFileSync('/tmp/euler-verify-p3/memories.jsonl', 'utf8')
})
globalThis.__eulerAppendMemory = (entry) => {
  appendLog.push(entry)
  const { appendFileSync } = require('node:fs')
  appendFileSync('/tmp/euler-verify-p3/memories.jsonl', entry)
}
globalThis.__eulerAppendUser = (section, line) => {
  const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
  const p = '/tmp/euler-verify-p3/user.md'
  let text = readFileSync(p, 'utf8')
  if (!text.includes('## ' + section)) text += '\r\n## ' + section + '\r\n'
  if (!text.includes('## ' + section)) {
    text += '\r\n## ' + section + '\r\n' + line + '\r\n'
  } else {
    // append after the section heading
    const idx = text.indexOf('## ' + section) + ('## ' + section).length
    text = text.slice(0, idx) + '\r\n' + line + text.slice(idx)
  }
  writeFileSync(p, text)
}

import { createAgentSession, DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent'
const loader = new DefaultResourceLoader({ cwd: '/tmp/euler-verify-p3', agentDir: '/tmp/euler-verify-p3/agent',
  additionalExtensionPaths: ['/tmp/euler-verify-p3/agent/extensions/euler-gate.mjs', '/tmp/euler-verify-p3/agent/extensions/euler-memory.mjs'] })
await loader.reload()
const { session } = await createAgentSession({ agentDir: '/tmp/euler-verify-p3/agent', cwd: '/tmp/euler-verify-p3', sessionManager: SessionManager.inMemory(), tools: ['read','bash','edit','write','memory_write','user_edit'], resourceLoader: loader })
await session.bindExtensions({ uiContext: { select: async()=>undefined, confirm: async()=>false, input: async()=>undefined, notify: ()=>{} }, mode: 'rpc' })
let answer = ''
let usedTool = false
session.subscribe(e => {
  if (e.type === 'tool_execution_start' && e.toolName === 'memory_write') usedTool = true
  if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') answer += e.assistantMessageEvent.delta
})
await session.prompt('Remember this fact for future sessions: My favorite music genre is metal. Acknowledge in one sentence.')
console.log('tool used:', usedTool ? 'PASS' : 'FAIL')
console.log('memories now:', JSON.stringify(readFileSync('/tmp/euler-verify-p3/memories.jsonl','utf8')))
session.dispose()
