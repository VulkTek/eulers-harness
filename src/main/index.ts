// Euler's Harness — Electron main process. Embeds pi SDK sessions and serves them to the renderer over IPC.
import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import { join } from 'path'
import { mkdir } from 'fs/promises'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { PiHost } from './pihost'
import { SessionStore } from './sessions'
import { ConfigManager } from './config'
import { indexDocsDir, ragStatus } from './rag-indexer'
import * as fsNode from 'fs'
import { checkForUpdate, applyUpdate, ensureLaunchTask } from './updater'
import { ensureLocalOllama, isLocalOllamaUrl, warmOllamaModel } from './ollama-serve'

const isDev = !app.isPackaged
const EULER_DIR = process.env.EULER_HOME ?? join(app.getPath('home'), '.euler')
const AGENT_DIR = join(EULER_DIR, 'agent')

app.setName("Euler's Harness")

let win: BrowserWindow | null = null
let piHost: PiHost | null = null
let sessionStore: SessionStore | null = null

const configManager = new ConfigManager(EULER_DIR)

function loadConfig(): Parameters<PiHost['init']>[0] {
  const cfg = configManager.load()
  if (cfg.workspaceDir === '') cfg.workspaceDir = app.getPath('home')
  return cfg
}

async function listEndpointModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  try {
    const res = await fetch(baseUrl.replace(/\/$/, '') + '/models', {
      headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {}
    })
    if (!res.ok) return []
    const data = (await res.json()) as { data?: Array<{ id?: string }> }
    return (data.data ?? []).map(m => m.id ?? '').filter(Boolean).slice(0, 60)
  } catch {
    return []
  }
}

// Native Ollama API (/api/tags) — the wizard's Ollama section probes this for model discovery.
async function probeOllamaTags(apiHost: string): Promise<string[]> {
  try {
    const res = await fetch(apiHost.replace(/\/+$/, '') + '/api/tags', { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return []
    const data = (await res.json()) as { models?: Array<{ name?: string }> }
    return (data.models ?? []).map(m => m.name ?? '').filter(Boolean).slice(0, 60)
  } catch {
    return []
  }
}

async function probeOllamaDetailed(apiHost: string): Promise<Array<{ id: string; sizeGb?: number }>> {
  try {
    const res = await fetch(apiHost.replace(/\/+$/, '') + '/api/tags', { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return []
    const data = (await res.json()) as { models?: Array<{ name?: string; size?: number }> }
    return (data.models ?? []).map(m => ({
      id: m.name ?? '',
      ...(typeof m.size === 'number' ? { sizeGb: Math.round((m.size / 2 ** 30) * 10) / 10 } : {})
    })).filter(m => m.id).slice(0, 60)
  } catch {
    return []
  }
}

async function probeOpenAIModels(baseUrl: string, timeoutMs = 1200): Promise<string[]> {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/models', { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return []
    const data = (await res.json()) as { data?: Array<{ id?: string }> }
    return (data.data ?? []).map(m => m.id ?? '').filter(Boolean).slice(0, 60)
  } catch {
    return []
  }
}

function winIconPath(): string {
  // blank window icon per user preference (taskbar/title bar show nothing);
  // packaged + dev both carry resources/icon-blank.png
  const packaged = join(String((process as { resourcesPath?: string }).resourcesPath ?? ''), 'resources/icon-blank.png')
  if (existsSync(packaged)) return packaged
  return join(__dirname, '../../resources/icon-blank.png')
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#191512',
    title: "Euler's Harness",
    icon: winIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  // DevTools stay closed; open manually with Ctrl+Shift+I via menu accelerator omitted for now
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    // cache-bust: renderer assets change between launches during dev
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { v: String(Date.now()) } })
  }
  win.on('closed', () => {
    win = null
  })
}

void app.whenReady().then(() => {
  // renderer assets change between dev launches; Chromium's disk cache poisons them
  if (!app.isPackaged) void session.defaultSession.clearCache()
})

// GUI dialogs for pi ctx.ui — bridge to renderer over IPC with promise resolution.
let pendingUi: Map<string, (value: unknown) => void> = new Map()

function wireUiBridge(host: PiHost): void {
  host.setUiBridge({
    confirm: (title, message) => new Promise(resolve => {
      const id = Math.random().toString(36).slice(2)
      pendingUi.set(id, resolve as (v: unknown) => void)
      win?.webContents.send('ui:confirm-request', { id, title, message })
    }),
    select: (title, options) => new Promise(resolve => {
      const id = Math.random().toString(36).slice(2)
      pendingUi.set(id, resolve as (v: unknown) => void)
      win?.webContents.send('ui:select-request', { id, title, options })
    }),
    input: (title, placeholder) => new Promise(resolve => {
      const id = Math.random().toString(36).slice(2)
      pendingUi.set(id, resolve as (v: unknown) => void)
      win?.webContents.send('ui:input-request', { id, title, placeholder })
    }),
    notify: (message, type) => {
      win?.webContents.send('ui:notify', { message, type })
    }
  })
}

function broadcast(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

async function init(): Promise<void> {
  await mkdir(AGENT_DIR, { recursive: true })
  const config = loadConfig()
  sessionStore = new SessionStore(EULER_DIR)
  await sessionStore.init()
  piHost = new PiHost(EULER_DIR, AGENT_DIR, sessionStore, config.workspaceDir)
  wireUiBridge(piHost)
  piHost.setBroadcast(broadcast)
  const ready = await piHost.init(config)
  if (!ready) console.error('[pihost] model init failed; check ollama/models')
  // bring the configured provider's server and model up in the background (ollama only)
  if (config.provider === 'ollama') {
    if (isLocalOllamaUrl(config.ollamaUrl ?? 'http://127.0.0.1:11434')) {
      void ensureLocalOllama(config.ollamaUrl ?? 'http://127.0.0.1:11434').then(r => {
        if (r.ok && config.modelId) return warmOllamaModel(config.ollamaUrl ?? 'http://127.0.0.1:11434', config.modelId)
      })
    } else if (config.modelId) {
      void warmOllamaModel(config.ollamaUrl ?? 'http://127.0.0.1:11434', config.modelId)
    }
  }
  createWindow()
}

function wireIpc(): void {
  ipcMain.handle('harness:config', () => piHost?.getConfig())
  ipcMain.handle('harness:prompt', (_e, text: string) => piHost?.promptAsync(text))
  ipcMain.handle('harness:steer', (_e, text: string) => piHost?.steer(text))
  ipcMain.handle('harness:follow-up', (_e, text: string) => piHost?.followUp(text))
  ipcMain.handle('harness:abort', () => piHost?.abort())
  ipcMain.handle('harness:new-session', () => piHost?.newSession())
  ipcMain.handle('harness:list-sessions', () => sessionStore?.listSessions())
  ipcMain.handle('harness:open-session', (_e, id: string) => piHost?.openSession(id))
  ipcMain.handle('harness:get-messages', (_e, id: string) => sessionStore?.getMessages(id))
  ipcMain.handle('harness:rename-session', (_e, id: string, name: string) => { sessionStore?.renameSession(id, name) })
  ipcMain.handle('harness:delete-session', (_e, id: string) => { sessionStore?.deleteSession(id) })
  ipcMain.handle('harness:metrics', () => piHost?.metrics())
  ipcMain.handle('harness:welcome', () => piHost?.welcomeMessage())
  ipcMain.handle('harness:search', (_e, query: string) => sessionStore?.searchAll(query))
  ipcMain.handle('harness:save-paste', async (_e, content: string, ext: string) => {
    const inbox = join(EULER_DIR, 'inbox')
    await mkdir(inbox, { recursive: true })
    const name = `paste-${Date.now()}.${ext || 'txt'}`
    const full = join(inbox, name)
    await (await import('fs/promises')).writeFile(full, content)
    return { path: full }
  })
  ipcMain.handle('harness:regenerate', () => piHost?.regenerate())
  ipcMain.handle('harness:compact', () => piHost?.['compactNow']?.())
  ipcMain.handle('updater:check', () => checkForUpdate())
  ipcMain.handle('updater:apply', () => applyUpdate(win ?? undefined))
  ipcMain.handle('ui:confirm-answer', (_e, id: string, answer: boolean) => {
    pendingUi.get(id)?.(answer)
    pendingUi.delete(id)
  })
  ipcMain.handle('ui:select-answer', (_e, id: string, choice: string | undefined) => {
    pendingUi.get(id)?.(choice)
    pendingUi.delete(id)
  })
  ipcMain.handle('ui:input-answer', (_e, id: string, text: string | undefined) => {
    pendingUi.get(id)?.(text)
    pendingUi.delete(id)
  })

  // Wizard (P4)
  ipcMain.handle('wizard:config', () => {
    const cfg = configManager.load()
    // strip plaintext key from anything sent to renderer
    const { _apiKeyPlain, ...safe } = cfg as typeof cfg & { _apiKeyPlain?: string }
    void _apiKeyPlain
    return safe
  })
  ipcMain.handle('wizard:set-provider', async (_e, patch: { provider?: string; baseUrl?: string; modelId?: string; apiKey?: string; contextLimit?: number; workspaceDir?: string; embedUrl?: string; ragDocsDir?: string; ollamaUrl?: string }) => {
    const cfg = configManager.load()
    if (patch.provider !== undefined) cfg.provider = patch.provider
    if (patch.baseUrl !== undefined) cfg.baseUrl = patch.baseUrl
    if (patch.modelId !== undefined) cfg.modelId = patch.modelId
    if (patch.contextLimit !== undefined) cfg.contextLimit = patch.contextLimit
    if (patch.workspaceDir !== undefined) cfg.workspaceDir = patch.workspaceDir
    if (patch.embedUrl !== undefined) cfg.embedUrl = patch.embedUrl
    if (patch.ragDocsDir !== undefined) cfg.ragDocsDir = patch.ragDocsDir
    if (patch.ollamaUrl !== undefined) cfg.ollamaUrl = patch.ollamaUrl
    if (patch.apiKey !== undefined && patch.apiKey !== '') cfg.apiKeyPlain = patch.apiKey
    const keySet = cfg.apiKeySet
    configManager.save(cfg)
    // rebuild models.json + restart session with new config
    const modelsPath = join(AGENT_DIR, 'models.json')
    if (existsSync(modelsPath) && patch.provider !== undefined) {
      // provider changed: drop stale models.json so ensureModelsJson regenerates
      const { unlinkSync } = await import('fs')
      try { unlinkSync(modelsPath) } catch {}
    }
    // grab the local ollama serve before rebuilding the agent session (starts one if none is running)
    if (cfg.provider === 'ollama') {
      await ensureLocalOllama(cfg.ollamaUrl ?? 'http://127.0.0.1:11434')
      // spin the selected model up too: background weight-load so the next prompt is instant
      void warmOllamaModel(cfg.ollamaUrl ?? 'http://127.0.0.1:11434', cfg.modelId ?? '')
    }
    if (piHost) {
      piHost.dispose()
    }
    // piHost.dispose() closes the shared SessionStore sqlite handle; reopen so the fresh PiHost has a live db.
    sessionStore = new SessionStore(EULER_DIR)
    piHost = new PiHost(EULER_DIR, AGENT_DIR, sessionStore, cfg.workspaceDir)
    wireUiBridge(piHost)
    piHost.setBroadcast(broadcast)
    const ready = await piHost.init({ ...cfg, apiKeySet: patch.apiKey !== undefined ? patch.apiKey !== '' : keySet })
    return { ok: ready, config: { ...cfg, _apiKeyPlain: undefined } }
  })
  ipcMain.handle('wizard:probe-endpoint', async (_e, baseUrl: string, apiKey?: string, ollamaApi?: string) => {
    let models: string[] = []
    let ollamaApiOk: boolean | undefined
    if (ollamaApi) {
      models = await probeOllamaTags(ollamaApi)
      ollamaApiOk = models.length > 0
    }
    if (models.length === 0) models = await listEndpointModels(baseUrl, apiKey)
    return { reachable: models.length > 0, models, ollamaApiOk }
  })

  // Ollama model pull: streams /api/pull (the same work the ollama CLI's pull does) with live progress events.
  let activePull: AbortController | null = null
  ipcMain.handle('wizard:ollama-pull', async (_e, model: string, ollamaApi?: string) => {
    const name = String(model ?? '').trim()
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(name)) return { ok: false, error: 'invalid model name' }
    if (activePull) return { ok: false, error: 'a pull is already running' }
    const api = (ollamaApi || configManager.load().ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '')
    activePull = new AbortController()
    const lastEmit = { pct: -1, status: '' }
    try {
      const res = await fetch(api + '/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, stream: true }),
        signal: activePull.signal
      })
      if (!res.ok || !res.body) return { ok: false, error: 'ollama pull failed (HTTP ' + res.status + ')' }
      let buf = ''
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk as unknown as Uint8Array).toString('utf8')
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          let evt: { status?: string; error?: string; total?: number; completed?: number } = {}
          try { evt = JSON.parse(line) } catch { continue }
          if (evt.error) return { ok: false, error: evt.error }
          const pct = evt.total && evt.completed ? Math.min(100, Math.round((evt.completed / evt.total) * 100)) : undefined
          if (evt.status && (evt.status !== lastEmit.status || (pct !== undefined && pct !== lastEmit.pct))) {
            broadcast('ollama:pull', { model: name, status: evt.status, pct })
            lastEmit.status = evt.status
            lastEmit.pct = pct ?? -1
          }
          if (evt.status === 'success') {
            const models = await probeOllamaTags(api)
            return { ok: true, models }
          }
        }
      }
      return { ok: false, error: 'ollama connection ended before completion' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: /abort|cancel/i.test(msg) ? 'cancelled' : msg }
    } finally {
      activePull = null
    }
  })
  ipcMain.handle('wizard:ollama-pull-cancel', () => {
    activePull?.abort()
    return { ok: true }
  })

  // Multi-source model discovery for the header model menu: ollama (local + configured host),
  // vLLM, llama.cpp server, LM Studio, plus whatever endpoint is configured.
  ipcMain.handle('models:discover', async () => {
    const cfg = configManager.load()
    const ollamaBase = (cfg.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '')
    // grabbing the local ollama serve: probe, and if nothing is listening spawn `ollama serve` and wait
    if (isLocalOllamaUrl(ollamaBase)) {
      const first = await probeOllamaDetailed(ollamaBase)
      if (first.length === 0) await ensureLocalOllama(ollamaBase)
    }
    type Source = { source: string; kind: string; baseUrl: string; host: string; models: Array<{ id: string; sizeGb?: number }> }
    const jobs: Array<Promise<Source | null>> = [
      probeOllamaDetailed(ollamaBase).then(models => models.length > 0
        ? { source: 'ollama · ' + ollamaBase, kind: 'ollama', baseUrl: ollamaBase + '/v1', host: ollamaBase, models }
        : null),
      probeOpenAIModels('http://127.0.0.1:8000/v1').then(models => models.length > 0
        ? { source: 'vllm · http://127.0.0.1:8000', kind: 'openai-completions', baseUrl: 'http://127.0.0.1:8000/v1', host: 'http://127.0.0.1:8000', models: models.map(id => ({ id })) }
        : null),
      probeOpenAIModels('http://127.0.0.1:8080/v1').then(models => models.length > 0
        ? { source: 'llama.cpp · http://127.0.0.1:8080', kind: 'openai-completions', baseUrl: 'http://127.0.0.1:8080/v1', host: 'http://127.0.0.1:8080', models: models.map(id => ({ id })) }
        : null),
      probeOpenAIModels('http://127.0.0.1:1234/v1').then(models => models.length > 0
        ? { source: 'lmstudio · http://127.0.0.1:1234', kind: 'openai-completions', baseUrl: 'http://127.0.0.1:1234/v1', host: 'http://127.0.0.1:1234', models: models.map(id => ({ id })) }
        : null)
    ]
    // configured endpoint (custom servers, API providers) unless it duplicates the ollama host
    if (cfg.baseUrl && !cfg.baseUrl.startsWith(ollamaBase)) {
      const host = cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
      jobs.push(probeOpenAIModels(cfg.baseUrl, 3000).then(models => models.length > 0
        ? { source: (cfg.provider || 'endpoint') + ' · ' + host, kind: 'openai-completions', baseUrl: cfg.baseUrl, host, models: models.map(id => ({ id })) }
        : null))
    }
    return (await Promise.all(jobs)).filter((s): s is Source => s !== null)
  })
  ipcMain.handle('wizard:rag-status', () => ragStatus(EULER_DIR))
  ipcMain.handle('wizard:index-rag', async (_e, docsDir: string, embedUrl: string) => {
    const cfg = configManager.load()
    const key = (cfg as typeof cfg & { _apiKeyPlain?: string })._apiKeyPlain
    try {
      const r = await indexDocsDir(docsDir, embedUrl, EULER_DIR, key, (phase, done, total, message) => {
        broadcast('rag:progress', { phase, done, total, message })
      })
      return { ok: true, ...r }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ;(globalThis as { __eulerNodeFs?: unknown }).__eulerNodeFs = fsNode

  ipcMain.handle('wizard:export', async () => {
    const { execSync } = await import('child_process')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const out = join(EULER_DIR, '..', "Euler-export-" + stamp + '.zip')
    try {
      execSync(`zip -r ${JSON.stringify(out)} . -x "sessions.db-wal" -x "sessions.db-shm"`, { cwd: EULER_DIR, stdio: 'pipe' })
      return { ok: true, path: out }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('wizard:wipe', async () => {
    // destructive: remove ~/.euler contents except config.json (provider data user may keep)
    for (const name of ['sessions', 'sessions.db', 'sessions.db-wal', 'sessions.db-shm', 'agent/extensions', 'memory.db']) {
      const p = join(EULER_DIR, name)
      if (existsSync(p)) rmSync(p, { recursive: true, force: true })
    }
    if (sessionStore) {
      // drop all rows
      sessionStore.close()
      sessionStore = null
    }
    return { ok: true }
  })
}

app.whenReady().then(async () => {
  wireIpc()
  await init()
  ensureLaunchTask()
}).catch(err => {
  console.error('[main] init failed:', err)
  app.quit()
})

app.on('window-all-closed', () => {
  piHost?.dispose()
  if (process.platform !== 'darwin') app.quit()
})
