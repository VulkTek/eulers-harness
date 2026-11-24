// P1 verify: drive PiHost + SessionStore end-to-end headless (no Electron).
// Confirms: session creation, prompt streaming, tool execution, persistence, metrics.
import { execSync } from 'child_process'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const eulerDir = '/tmp/euler-verify-p1'
if (existsSync(eulerDir)) rmSync(eulerDir, { recursive: true, force: true })
const agentDir = join(eulerDir, 'agent')
mkdirSync(agentDir, { recursive: true })

// minimal config, mirroring main/index.ts defaults
const config = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKeySet: false,
  modelId: 'qwen3:8b',
  contextLimit: 40960,
  ollamaUrl: 'http://127.0.0.1:11434',
  workspaceDir: '/tmp/euler-verify-p1'
}

// transpile main sources to a temp dir so we can import them without electron
execSync('npx tsc --outDir /tmp/euler-p1-build --module ESNext --moduleResolution bundler --target ES2023 --skipLibCheck --strict src/main/pihost.ts src/main/sessions.ts src/shared/types.ts', { cwd: '/var/home/phoenixphoenix/dev/eulers-harness', stdio: 'inherit' })

const { PiHost } = await import('/tmp/euler-p1-build/main/pihost.js')
const { SessionStore } = await import('/tmp/euler-p1-build/main/sessions.js')

const store = new SessionStore(eulerDir)
await store.init()

const events = []
const host = new PiHost(agentDir, store)
host.setBroadcast((channel, payload) => events.push({ channel, payload: JSON.stringify(payload).slice(0, 80) }))
const ready = await host.init(config)
console.log('init ready:', ready)
if (!ready) throw new Error('init failed')

const r = await host.prompt('Write a file called verify.txt with the number 42 inside. Confirm with one sentence.')
console.log('prompt result:', JSON.stringify(r))

await new Promise(res => setTimeout(res, 1500)) // allow settled event

const sessions = store.listSessions()
console.log('sessions:', sessions.length, '| msgs:', store.getMessages(sessions[0].id).length)
const m = host.metrics()
console.log('metrics: model=' + m.modelId, 'tok/s=' + m.tokPerSec, 'latency=' + m.latencyMs)
console.log('event channels seen:', [...new Set(events.map(e => e.channel))].join(', '))

const verifyFile = join('/tmp/euler-verify-p1', 'verify.txt')
const fileContent = existsSync(verifyFile) ? (await import('fs')).readFileSync(verifyFile, 'utf8') : 'MISSING'
console.log('verify.txt content:', fileContent.trim())

const pass = r.ok && sessions.length === 1 && fileContent.trim() === '42' && events.some(e => e.channel === 'pi:tool-start')
console.log('P1-HEADLESS-VERIFY:', pass ? 'PASS' : 'FAIL')
host.dispose()
process.exit(pass ? 0 : 1)
