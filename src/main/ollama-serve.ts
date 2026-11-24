// Ensure a local Ollama serve is running: answer /api/tags, spawn `ollama serve` if not, wait for readiness.
// Remote URLs are never touched (nothing to start on another host). Zero dependencies.
import { spawn, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i

export function isLocalOllamaUrl(api: string): boolean {
  return LOCAL_RE.test((api ?? '').replace(/\/+$/, ''))
}

function candidates(): string[] {
  const out: string[] = []
  if (process.platform === 'win32') {
    const lad = process.env.LOCALAPPDATA ?? ''
    if (lad) out.push(join(lad, 'Programs', 'Ollama', 'ollama.exe'))
    out.push(join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Ollama', 'ollama.exe'))
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Ollama.app/Contents/Resources/ollama', '/usr/local/bin/ollama')
  } else {
    out.push('/usr/bin/ollama', '/usr/local/bin/ollama')
    const home = process.env.HOME ?? ''
    if (home) out.push(join(home, '.local', 'bin', 'ollama'))
  }
  out.push('ollama') // let PATH resolve as a last resort
  return out
}

async function up(base: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base.replace(/\/+$/, '') + '/api/tags', {
        signal: AbortSignal.timeout(1500),
        headers: { 'User-Agent': 'eulers-harness' }
      })
      if (r.ok) return true
    } catch { /* retry until deadline */ }
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

export async function ensureLocalOllama(api: string, waitMs = 15000): Promise<{ ok: boolean; spawned: boolean; error?: string }> {
  const base = (api ?? '').replace(/\/+$/, '')
  if (!isLocalOllamaUrl(base)) return { ok: false, spawned: false, error: 'remote ollama url: nothing to start on this host' }
  if (await up(base, 2500)) return { ok: true, spawned: false }
  for (const bin of candidates()) {
    try {
      if (!bin.includes('\\') && !bin.includes('/')) {
        if (process.platform === 'win32') {
          const w = spawnSync('where', [bin], { encoding: 'utf8' })
          if (w.status !== 0) continue
        } else {
          const w = spawnSync('/bin/sh', ['-c', `command -v ${bin} 2>/dev/null`], { encoding: 'utf8' })
          if (w.status !== 0 || !(w.stdout ?? '').trim()) continue
        }
      } else if (!existsSync(bin)) continue
      const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      if (await up(base, waitMs)) return { ok: true, spawned: true }
      return { ok: false, spawned: true, error: 'spawned serve but it did not answer in time' }
    } catch { /* try the next candidate */ }
  }
  return { ok: false, spawned: false, error: 'ollama executable not found — install ollama or point the endpoint somewhere else' }
}

// Warm a model: triggers the weights load so the next real prompt lands on an in-memory
// model instead of paying cold-load latency. Uses ollama's default keep_alive (5 min).
// Works for local and remote ollama alike; harmless one-token generation.
export async function warmOllamaModel(api: string, modelId: string): Promise<boolean> {
  const base = (api ?? '').replace(/\/+$/, '')
  if (!modelId) return false
  try {
    const r = await fetch(base + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'eulers-harness' },
      body: JSON.stringify({ model: modelId, prompt: 'ready?', stream: false, options: { num_predict: 1 } }),
      signal: AbortSignal.timeout(120000)
    })
    return r.ok
  } catch { return false }
}

// One call for "the app is about to use this model": make sure a local serve is up,
// then load the model. Local URLs get serve-started; remote URLs just get warmed.
export async function ensureOllamaWithModel(api: string, modelId: string): Promise<void> {
  const base = (api ?? '').replace(/\/+$/, '')
  if (!modelId) return
  if (isLocalOllamaUrl(base)) {
    const r = await ensureLocalOllama(base)
    if (r.ok) await warmOllamaModel(base, modelId)
  } else {
    await warmOllamaModel(base, modelId)
  }
}
