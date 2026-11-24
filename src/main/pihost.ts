// PiHost: embeds the pi SDK agent session in the Electron main process.
// Event flow: pi session events -> summarized -> forwarded to renderer via webContents.send.
import type { AgentSession, ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { createAgentSession, DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent'
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'fs'
import * as fsModule from 'fs'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import type { HarnessConfig, ToolCallSummary } from '../shared/types'
import type { SessionStore } from './sessions'

type Broadcast = (channel: string, payload: unknown) => void

interface TurnTracker {
  assistantText: string
  toolCalls: Map<string, ToolCallSummary>
  usage: { totalTokens: number; outputTokens: number; costUsd: number }
  firstTokenAt: number | null
  streamStartedAt: number | null
  streaming: boolean
  msgFirstTokenAt: number | null
  msgStartLen: number
  msgTokPerSec: number | null
}

interface UiBridge {
  confirm: (title: string, message: string) => Promise<boolean>
  select: (title: string, options: string[]) => Promise<string | undefined>
  input: (title: string, placeholder?: string) => Promise<string | undefined>
  notify: (message: string, type?: string) => void
}

export class PiHost {
  private agentDir: string
  private eulerDir: string
  private store: SessionStore
  private session: AgentSession | null = null
  private sessionId: string = randomUUID()
  private config: HarnessConfig | null = null
  private broadcast: Broadcast = () => {}
  private busy = false
  private welcomeSent = false
  private lastTotals: { totalTokens: number; outputTokens: number; costUsd: number } = { totalTokens: 0, outputTokens: 0, costUsd: 0 }
  // persists tok/s + latency after a turn settles (metrics() loses the tracker otherwise)
  private lastTurnMetrics: { tokPerSec: number | null; latencyMs: number | null } | null = null
  private tracker: TurnTracker | null = null
  private uiBridge: UiBridge | null = null
  private workspaceDir: string

  constructor(eulerDir: string, agentDir: string, store: SessionStore, workspaceDir: string) {
    this.eulerDir = eulerDir
    this.agentDir = agentDir
    this.store = store
    this.workspaceDir = workspaceDir
  }

  setBroadcast(fn: Broadcast): void {
    this.broadcast = fn
  }

  setUiBridge(bridge: UiBridge): void {
    this.uiBridge = bridge
  }

  getConfig(): { workspaceDir: string } & HarnessConfig | null {
    return this.config ? { ...this.config, workspaceDir: this.workspaceDir } : null
  }

  /** Welcome card for the current session; renderer polls once after mount. */
  welcomeMessage(): string | null {
    if (this.welcomeSent) return null
    this.welcomeSent = true
    const cfg = this.config
    if (!cfg) return null
    return `**Euler's Harness is running.**\n\nModel: ${cfg.modelId} on ${cfg.provider}.\n\n- Type below and send. It can read files, run code, and edit inside your workspace.\n- ⚙ opens setup (models, API keys, RAG).\n- ⟳ starts a new chat; Ctrl+F searches this machine's entire history.\n- Destructive or network-touching commands will ask before running.`
  }

  async init(config: HarnessConfig): Promise<boolean> {
    this.config = config
    this.ensureModelsJson(config)
    this.seedMemoryFiles()
    await this.newSession()
    return this.session !== null
  }

  private ensureModelsJson(config: HarnessConfig): void {
    const path = join(this.agentDir, 'models.json')
    if (existsSync(path)) return
    const modelsJson = {
      $schema: 'https://pi.dev/schemas/models.schema.json',
      providers: {
        [config.provider]: {
          baseUrl: config.baseUrl,
          api: 'openai-completions',
          apiKey: config.apiKeySet ? 'env:EULER_API_KEY' : 'ollama',
          models: [{ id: config.modelId, contextWindow: config.contextLimit, maxTokens: Math.min(config.contextLimit, 8192) }]
        }
      }
    }
    mkdirSync(this.agentDir, { recursive: true })
    writeFileSync(path, JSON.stringify(modelsJson, null, 2))
  }

  private seedMemoryFiles(): void {
    const templates: Array<[string, string]> = [
      ['soul.md', "# Soul\n\nI am Euler's Harness, built by Phoenix of Vulktek Cyber Solutions.\n\n## Identity\n- Direct, warm, no filler. Say the thing and stop.\n- Honest about uncertainty. No hedging when I know.\n\n## Voice\n- Commas over em dashes.\n- Short answers by default; depth when the question earns it.\n"],
      ['user.md', '# User\n\nFacts about the owner. The harness updates this file as it learns.\n'],
      ['memories.jsonl', '']
    ]
    for (const [name, content] of templates) {
      const p = join(this.eulerDir, name)
      if (!existsSync(p)) writeFileSync(p, content)
    }
  }

  private refreshRagEnv(): void {
    // euler-rag.mjs reads env at call time; publish current config
    process.env.EULER_EMBED_URL = this.config?.embedUrl ?? ''
    process.env.EULER_API_KEY = this.config?.apiKeyPlain ?? ''
    process.env.EULER_HOME = this.eulerDir
    // node globals used by euler extensions
    ;(globalThis as { __eulerNodeFs?: unknown }).__eulerNodeFs = fsModule
  }

  private readMemoryFiles(): { soul: string; user: string; memories: string } {
    const read = (p: string): string => {
      try { return readFileSync(p, 'utf8') } catch { return '' }
    }
    return {
      soul: readFileSync(join(this.eulerDir, 'soul.md'), 'utf8'),
      user: read(join(this.eulerDir, 'user.md')),
      memories: read(join(this.eulerDir, 'memories.jsonl'))
    }
  }

  // Resources dir resolution: dev = repo resources/, packaged = extraResources/resources/
  private resourcesDir(): string {
    const packaged = resolve((process as { resourcesPath?: string }).resourcesPath ?? '', 'resources')
    if (existsSync(join(packaged, 'euler-gate.mjs'))) return packaged
    const dev = resolve(__dirname, '../../../resources')
    if (existsSync(join(dev, 'euler-gate.mjs'))) return dev
    return existsSync(packaged) ? packaged : dev
  }

  private gatePath(): string {
    const inAgent = join(this.agentDir, 'extensions', 'euler-gate.mjs')
    if (existsSync(inAgent)) return inAgent
    const src = join(this.resourcesDir(), 'euler-gate.mjs')
    if (existsSync(src)) {
      try {
        mkdirSync(join(this.agentDir, 'extensions'), { recursive: true })
        writeFileSync(inAgent, readFileSync(src))
        return inAgent
      } catch { /* fall through */ }
    }
    return inAgent
  }

  // GUI uiContext adapter: dialog-capable via bridge, no-op for TUI-only members.
  private buildUiContext(): ExtensionUIContext {
    const bridge = (): UiBridge => this.uiBridge ?? {
      confirm: async () => false,
      select: async () => undefined,
      input: async () => undefined,
      notify: () => {}
    }
    const noop = (): void => {}
    return {
      select: (title: string, options: string[]) => bridge().select(title, options),
      confirm: (title: string, message: string) => bridge().confirm(title, message),
      input: (title: string, placeholder?: string) => bridge().input(title, placeholder),
      notify: (message: string, type?: 'info' | 'warning' | 'error') => bridge().notify(message, type),
      editor: async (_title: string, prefill?: string) => bridge().input('Edit', prefill),
      onTerminalInput: () => () => {},
      setStatus: noop,
      setWorkingMessage: noop,
      setWorkingVisible: noop,
      setWorkingIndicator: noop,
      setHiddenThinkingLabel: noop,
      setWidget: noop,
      setFooter: noop,
      setHeader: noop,
      setTitle: noop,
      pasteToEditor: noop,
      setEditorText: noop,
      getEditorText: () => '',
      setEditorComponent: noop,
      getEditorComponent: () => undefined,
      addAutocompleteProvider: noop,
      getToolsExpanded: () => false,
      setToolsExpanded: noop
    } as unknown as ExtensionUIContext
  }

  private async makeSession(): Promise<AgentSession> {
    const gate = this.gatePath()
    const memorySource = join(this.resourcesDir(), 'euler-memory.mjs')
    const memoryPath = this.installEulerMemory(memorySource)
    const ragSource = join(this.resourcesDir(), 'euler-rag.mjs')
    const ragPath = this.installRag(ragSource)
    // personal layer: ~/.euler/extensions-local/*.mjs loaded when present, never shipped
    const localDir = join(this.eulerDir, 'extensions-local')
    const localPaths = existsSync(localDir)
      ? readdirSync(localDir).filter(n => n.endsWith('.mjs') || n.endsWith('.js')).map(n => join(localDir, n))
      : []
    this.refreshRagEnv()
    ;(globalThis as { __eulerReadFiles?: () => { soul: string; user: string; memories: string } }).__eulerReadFiles = () => this.readMemoryFiles()
    ;(globalThis as { __eulerAppendMemory?: (e: string) => void }).__eulerAppendMemory = (entry: string) => {
      appendFileSync(join(this.eulerDir, 'memories.jsonl'), entry)
    }
    ;(globalThis as { __eulerAppendUser?: (s: string, l: string) => void }).__eulerAppendUser = (section: string, line: string) => {
      const p = join(this.eulerDir, 'user.md')
      let text = existsSync(p) ? readFileSync(p, 'utf8') : ''
      if (!text.includes('## ' + section)) text += '\n## ' + section + '\n' + line + '\n'
      else {
        const idx = text.indexOf('## ' + section) + ('## ' + section).length
        text = text.slice(0, idx) + '\n' + line + text.slice(idx)
      }
      writeFileSync(p, text)
    }
    const loader = new DefaultResourceLoader({
      cwd: this.workspaceDir,
      agentDir: this.agentDir,
      additionalExtensionPaths: [gate, memoryPath, ragPath, ...localPaths].filter(p =>
        existsSync(p) && (p !== ragPath || (this.config?.embedUrl && this.config?.ragDocsDir))
      )
    })
    await loader.reload()
    const { session } = await createAgentSession({
      agentDir: this.agentDir,
      cwd: this.workspaceDir,
      sessionManager: SessionManager.inMemory(),
      tools: ['read', 'bash', 'edit', 'write'],
      resourceLoader: loader
    } as never)
    await session.bindExtensions({
      uiContext: this.buildUiContext(),
      mode: 'rpc'
    })
    return session
  }

  private installRag(src: string): string {
    const dest = join(this.agentDir, 'extensions', 'euler-rag.mjs')
    if (existsSync(src)) {
      try {
        mkdirSync(join(this.agentDir, 'extensions'), { recursive: true })
        writeFileSync(dest, readFileSync(src))
        return dest
      } catch { return dest }
    }
    return dest
  }

  private installEulerMemory(src: string): string {
    const dest = join(this.agentDir, 'extensions', 'euler-memory.mjs')
    if (existsSync(src)) {
      try {
        mkdirSync(join(this.agentDir, 'extensions'), { recursive: true })
        writeFileSync(dest, readFileSync(src))
        return dest
      } catch { return dest }
    }
    return dest
  }

  async newSession(): Promise<unknown> {
    this.session?.dispose()
    this.sessionId = randomUUID()
    this.session = await this.makeSession()
    this.store.createSession(this.sessionId, this.generateSessionName())
    this.wireSessionEvents()
    this.broadcast('session:new', { id: this.sessionId, name: this.getSessionName() })
    return { id: this.sessionId }
  }

  async openSession(id: string): Promise<boolean> {
    const msgs = this.store.getMessages(id)
    if (msgs.length === 0) return false
    const prevName = this.getSessionName()
    this.session?.dispose()
    this.session = await this.makeSession()
    this.sessionId = id
    this.wireSessionEvents()
    this.broadcast('session:open', { id, name: prevName, messages: msgs })
    return true
  }

  getSessionName(): string {
    return this.store.listSessions().find(s => s.id === this.sessionId)?.name ?? 'New chat'
  }

  private generateSessionName(): string {
    const now = new Date()
    return `Chat ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
  }

  private wireSessionEvents(): void {
    const session = this.session
    if (!session) return
    session.subscribe((event: { type: string }) => {
      switch (event.type) {
        case 'message_update': {
          const ame = (event as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent
          if ((ame?.type === 'text_delta' || ame?.type === 'thinking_delta') && ame.delta) {
            if (this.tracker) {
              if (this.tracker.msgFirstTokenAt === null) {
                this.tracker.msgFirstTokenAt = Date.now()
                this.tracker.msgStartLen = this.tracker.assistantText.length
              }
              if (this.tracker.firstTokenAt === null) this.tracker.firstTokenAt = Date.now()
              if (ame.type === 'text_delta') this.tracker.assistantText += ame.delta
            }
            if (ame.type === 'text_delta') this.broadcast('pi:text-delta', { delta: ame.delta })
          }
          const ameUsage = (event as { assistantMessageEvent?: { usage?: { totalTokens?: number; cost?: { total?: number } } } }).assistantMessageEvent?.usage
          if (ameUsage && Object.keys(ameUsage).length > 0) this.updateUsage(ameUsage)
          break
        }
        case 'message_end': {
          const msg = (event as { message?: { role?: string; usage?: { output?: number; totalTokens?: number; cost?: { total?: number } } } }).message
          if (msg?.role === 'assistant' && msg.usage) this.updateUsage(msg.usage)
          const t = this.tracker
          if (t && msg?.role === 'assistant') {
            // provider usage when available (exact), otherwise chars/4 estimate of this message's stream
            const out = typeof msg.usage?.output === 'number' && msg.usage.output > 0
              ? msg.usage.output
              : Math.round((t.assistantText.length - t.msgStartLen) / 4)
            const dur = t.msgFirstTokenAt ? (Date.now() - t.msgFirstTokenAt) / 1000 : 0
            if (out > 0 && dur > 0) t.msgTokPerSec = Math.max(1, Math.round(out / dur))
            if (t.msgTokPerSec !== null) {
              this.lastTurnMetrics = {
                tokPerSec: t.msgTokPerSec,
                latencyMs: (t.firstTokenAt && t.streamStartedAt) ? t.firstTokenAt - t.streamStartedAt : this.lastTurnMetrics?.latencyMs ?? null
              }
            }
            // tool runs pause token flow between assistant messages; re-measure for each message
            t.msgFirstTokenAt = null
            t.msgStartLen = t.assistantText.length
          }
          break
        }
        case 'tool_execution_start': {
          const e = event as unknown as { toolCallId: string; toolName: string; args: Record<string, unknown> }
          if (this.tracker) this.tracker.toolCalls.set(e.toolCallId, { toolCallId: e.toolCallId, toolName: e.toolName, args: e.args })
          this.broadcast('pi:tool-start', { toolCallId: e.toolCallId, toolName: e.toolName, args: e.args })
          break
        }
        case 'tool_execution_update': {
          const e = event as unknown as { toolCallId: string; toolName: string; partialResult?: { content?: Array<{ text?: string }> } }
          const partial = e.partialResult?.content?.map(c => c.text ?? '').join('') ?? ''
          this.broadcast('pi:tool-update', { toolCallId: e.toolCallId, toolName: e.toolName, partial })
          break
        }
        case 'tool_execution_end': {
          const e = event as unknown as { toolCallId: string; toolName: string; result?: { content?: Array<{ text?: string }>; isError?: boolean } }
          const result = e.result?.content?.map(c => c.text ?? '').join('') ?? ''
          if (this.tracker) {
            const tc = this.tracker.toolCalls.get(e.toolCallId)
            if (tc) tc.result = result
          }
          this.broadcast('pi:tool-end', { toolCallId: e.toolCallId, toolName: e.toolName, result, isError: e.result?.isError ?? false })
          break
        }
        case 'compaction_start': {
          const e = event as unknown as { reason: string }
          this.broadcast('pi:compaction-start', { reason: e.reason })
          break
        }
        case 'compaction_end': {
          const e = event as unknown as { reason: string; result?: { estimatedTokensAfter?: number } }
          this.broadcast('pi:compaction-end', { reason: e.reason, tokensAfter: e.result?.estimatedTokensAfter })
          break
        }
        case 'auto_retry_start': {
          const e = event as unknown as { errorMessage: string }
          this.broadcast('pi:error', { message: `retrying: ${e.errorMessage}` })
          break
        }
        case 'agent_settled': {
          this.finishTurn()
          break
        }
        default:
          break
      }
    })
  }

  private updateUsage(usage: { totalTokens?: number; output?: number; input?: number; cost?: { total?: number } }): void {
    if (!this.tracker) return
    // tok/s uses OUTPUT tokens this turn (what you're watching stream)
    if (typeof usage.output === 'number' && usage.output > 0) this.tracker.usage.outputTokens = usage.output
    this.tracker.usage.totalTokens = usage.totalTokens ?? this.tracker.usage.totalTokens
    const costNow = usage.cost?.total
    if (typeof costNow === 'number' && costNow > 0) this.tracker.usage.costUsd = costNow
    this.lastTotals = { totalTokens: this.tracker.usage.totalTokens, outputTokens: this.tracker.usage.outputTokens, costUsd: this.tracker.usage.costUsd }
  }

  private finishTurn(): void {
    const tracker = this.tracker
    if (!tracker) return
    if (tracker.msgTokPerSec === null && tracker.firstTokenAt && tracker.streamStartedAt) {
      // no message ended with a tok/s value (e.g. error turn); persist the latency at least
      this.lastTurnMetrics = { tokPerSec: this.lastTurnMetrics?.tokPerSec ?? null, latencyMs: tracker.firstTokenAt - tracker.streamStartedAt }
    }
    this.store.addMessage(this.sessionId, 'assistant', tracker.assistantText, Date.now(),
      JSON.stringify([...tracker.toolCalls.values()]), null)
    this.tracker = null
    this.broadcast('pi:message-end', { metrics: this.metrics() })
  }

  async prompt(text: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.session) return { ok: false, error: 'agent not ready' }
    if (this.busy) return { ok: false, error: 'busy: use Steer while streaming' }
    this.busy = true
    this.tracker = { assistantText: '', toolCalls: new Map(), usage: { totalTokens: 0, outputTokens: 0, costUsd: 0 }, firstTokenAt: null, streamStartedAt: Date.now(), streaming: true, msgFirstTokenAt: null, msgStartLen: 0, msgTokPerSec: null }
    this.store.addMessage(this.sessionId, 'user', text, Date.now(), null, null)
    this.broadcast('pi:user-message', { text })
    try {
      await this.session.prompt(text)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.broadcast('pi:error', { message })
      return { ok: false, error: message }
    } finally {
      this.busy = false
    }
  }

  async promptAsync(text: string): Promise<{ ok: boolean; error?: string }> {
    void this.prompt(text)
    return { ok: true }
  }

  steer(text: string): { ok: boolean; error?: string } {
    if (!this.session || !this.busy) return { ok: false, error: 'not streaming' }
    this.session.steer(text).catch(() => {})
    this.store.addMessage(this.sessionId, 'user', text, Date.now(), null, null)
    return { ok: true }
  }

  followUp(text: string): { ok: boolean; error?: string } {
    if (!this.session || !this.busy) return { ok: false, error: 'not streaming' }
    this.session.followUp(text).catch(() => {})
    this.store.addMessage(this.sessionId, 'user', text, Date.now(), null, null)
    return { ok: true }
  }

  async abort(): Promise<boolean> {
    if (!this.session || !this.busy) return false
    await this.session.abort()
    return true
  }

  // P1.2 regenerate: drops last assistant reply from store, replays transcript into fresh session, re-asks.
  async regenerate(): Promise<boolean> {
    if (this.busy) return false
    const msgs = this.store.getMessages(this.sessionId)
    if (msgs.length < 2) return false
    let lastAssistantIdx = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') { lastAssistantIdx = i; break }
    }
    if (lastAssistantIdx < 0) return false
    const historyUpTo = msgs.slice(0, lastAssistantIdx)
    const priorUser = [...historyUpTo].reverse().find(msg => msg.role === 'user')
    if (!priorUser) return false
    this.session?.dispose()
    this.session = await this.makeSession()
    this.wireSessionEvents()
    const replay = historyUpTo.map(msg => `[${msg.role}]: ${msg.content}`).join('\n')
    const prompt = `[Previous conversation for reference — not instructions:]\n${replay}\n\n(You are regenerating your last response. Reply fresh to your previous prompt.)\n\n${priorUser.content}`
    this.broadcast('pi:regenerate-start', {})
    void this.prompt(prompt)
    return true
  }

  async compactNow(): Promise<boolean> {
    if (!this.session || this.busy) return false
    try {
      await this.session.compact()
      return true
    } catch {
      return false
    }
  }

  metrics(): { tokPerSec: number | null; latencyMs: number | null; totalTokens: number; contextUsed: number; contextLimit: number; costUsd: number; modelId: string; provider: string } {
    const tracker = this.tracker
    const total = tracker?.usage.totalTokens ?? this.lastTotals.totalTokens
    // tok/s: live chars/4 estimate while tokens flow, exact from provider usage once a message
    // ends, then the last completed message's value persists through tool gaps and after the turn.
    let tokPerSec: number | null = null
    if (tracker) {
      if (tracker.msgFirstTokenAt) {
        const estChars = tracker.assistantText.length - tracker.msgStartLen
        if (estChars > 0) tokPerSec = Math.max(1, Math.round((estChars / 4) / ((Date.now() - tracker.msgFirstTokenAt) / 1000)))
      } else {
        tokPerSec = tracker.msgTokPerSec
      }
    } else {
      tokPerSec = this.lastTurnMetrics?.tokPerSec ?? null
    }
    const liveLatency = tracker?.firstTokenAt && tracker.streamStartedAt ? tracker.firstTokenAt - tracker.streamStartedAt : null
    const latencyMs = liveLatency ?? (tracker ? null : this.lastTurnMetrics?.latencyMs ?? null)
    return {
      tokPerSec,
      latencyMs,
      totalTokens: total,
      contextUsed: total,
      contextLimit: this.config?.contextLimit ?? 40960,
      costUsd: tracker?.usage.costUsd ?? 0,
      modelId: this.config?.modelId ?? 'unknown',
      provider: this.config?.provider ?? 'unknown'
    }
  }

  dispose(): void {
    this.session?.dispose()
    this.store.close()
  }
}
