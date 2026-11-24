// Euler's Harness renderer — Solid.js dashboard app.
import { createSignal, For, Show, onMount, onCleanup, createMemo, Switch, Match } from 'solid-js'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github-dark.css'
import { Wizard, type WizardConfig } from './Wizard'
import vulktekLogo from './vulktek-logo-lockup.png'

interface ToolCall { toolCallId: string; toolName: string; args: Record<string, unknown>; result?: string; isError?: boolean; running?: boolean }
interface Msg { id: string; role: 'user' | 'assistant'; content: string; ts: number; toolCalls?: ToolCall[]; error?: string }
interface SessionRow { id: string; name: string; createdAt: number; lastActive: number; messageCount: number }
interface Metrics { tokPerSec: number | null; latencyMs: number | null; totalTokens: number; contextUsed: number; contextLimit: number; costUsd: number; modelId: string; provider: string }
interface UiRequest { id: string; title: string; message?: string; options?: string[]; placeholder?: string }

declare global {
  interface Window {
    api: {
      on: (ch: string, fn: (...a: unknown[]) => void) => () => void
      getConfig: () => Promise<WizardConfig | null>
      sendPrompt: (t: string) => Promise<{ ok: boolean; error?: string }>
      steer: (t: string) => Promise<{ ok: boolean; error?: string }>
      followUp: (t: string) => Promise<{ ok: boolean; error?: string }>
      abort: () => Promise<boolean>
      newSession: () => Promise<unknown>
      listSessions: () => Promise<SessionRow[]>
      openSession: (id: string) => Promise<boolean>
      getMessages: (id: string) => Promise<Array<{ sessionId: string; role: string; content: string; timestamp: number; toolCalls: string | null; error: string | null }>>
      renameSession: (id: string, name: string) => Promise<void>
      deleteSession: (id: string) => Promise<void>
      search: (q: string) => Promise<Array<{ sessionId: string; sessionName: string; role: string; content: string; ts: number }>>
      savePaste: (content: string, ext: string) => Promise<{ path: string }>
      indexRag: (docsDir: string, embedUrl: string) => Promise<{ ok: boolean; chunks?: number; files?: number; error?: string }>
      exportData: () => Promise<{ ok: boolean; path?: string; error?: string }>
      wipeData: () => Promise<{ ok: boolean; error?: string }>
      updaterCheck: () => Promise<{ current: string; latest: string | null; updateAvailable: boolean; assetUrl: string | null; dev: boolean; error?: string }>
      updaterApply: () => Promise<{ started: boolean; error?: string }>
      metrics: () => Promise<Metrics | null>
      getWelcome: () => Promise<string | null>
      compact: () => Promise<boolean>
      regenerate: () => Promise<boolean>
      wizardConfig: () => Promise<WizardConfig | null>
      setProvider: (patch: Record<string, unknown>) => Promise<{ ok: boolean }>
      probeEndpoint: (url: string, key?: string, ollamaApi?: string) => Promise<{ reachable: boolean; models: string[]; ollamaApiOk?: boolean }>
      discoverModels: () => Promise<Array<{ source: string; kind: string; baseUrl: string; host: string; models: Array<{ id: string; sizeGb?: number }> }>>
      pullModel: (model: string, ollamaApi?: string) => Promise<{ ok: boolean; models?: string[]; error?: string }>
      cancelPull: () => Promise<{ ok: boolean }>
      answerConfirm: (id: string, answer: boolean) => Promise<void>
      answerSelect: (id: string, choice: string | undefined) => Promise<void>
      answerInput: (id: string, text: string | undefined) => Promise<void>
    }
  }
}

const md = (text: string): string => {
  const html = marked.parse(text, { async: false, gfm: true, breaks: true }) as string
  const div = document.createElement('div')
  div.innerHTML = html
  div.querySelectorAll('pre code').forEach(el => { hljs.highlightElement(el as HTMLElement) })
  return div.innerHTML
}

const uid = (): string => Math.random().toString(36).slice(2) + Date.now().toString(36)

declare global { interface Window { __eulerMarked?: (t: string) => string } }
window.__eulerMarked = md

export function App() {
  const [messages, setMessages] = createSignal<Msg[]>([])
  const [input, setInput] = createSignal('')
  const [streaming, setStreaming] = createSignal(false)
  const [streamingAssistant, setStreamingAssistant] = createSignal('')
  const [sessions, setSessions] = createSignal<SessionRow[]>([])
  const [activeSession, setActiveSession] = createSignal('')
  const [sessionName, setSessionName] = createSignal('New chat')
  const [toolCards, setToolCards] = createSignal<ToolCall[]>([])
  const [model, setModel] = createSignal({ modelId: '…', provider: '…' })
  const [metrics, setMetrics] = createSignal<Metrics | null>(null)
  const [wizard, setWizard] = createSignal<WizardConfig | null>(null)
  const [wizardOpen, setWizardOpen] = createSignal(false)
  const [firstRun, setFirstRun] = createSignal(false)
  const [uiRequests, setUiRequests] = createSignal<UiRequest[]>([])
  const [uiAnswer, setUiAnswer] = createSignal('')
  const [toast, setToast] = createSignal('')
  const [pastedChips, setPastedChips] = createSignal<Array<{ name: string; path: string; ref: string }>>([])
  const [searchOpen, setSearchOpen] = createSignal(false)
  const [searchQ, setSearchQ] = createSignal('')
  const [searchHits, setSearchHits] = createSignal<Array<{ sessionId: string; sessionName: string; role: string; content: string; ts: number }>>([])
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  const runSearch = async (): Promise<void> => {
    const q = searchQ().trim()
    if (q.length < 2) { setSearchHits([]); return }
    const hits = await window.api.search(q)
    setSearchHits(hits)
  }
  const onSearchInput = (v: string): void => {
    setSearchQ(v)
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { void runSearch() }, 250)
  }
  const jumpTo = async (hit: { sessionId: string }): Promise<void> => {
    setSearchOpen(false)
    if (hit.sessionId !== activeSession()) await openSession(hit.sessionId)
  }
  const openSearch = (): void => { setSearchOpen(true); setTimeout(() => { document.getElementById('euler-search-input')?.focus() }, 50) }
  let messagesEl: HTMLDivElement | undefined
  let streamMsgId = ''

  // self-updater chip states
  const [upState, setUpState] = createSignal<'idle' | 'checking' | 'ready' | 'downloading' | 'restarting'>('idle')
  const [upLatest, setUpLatest] = createSignal('')
  const [upPct, setUpPct] = createSignal(0)
  const [upMsg, setUpMsg] = createSignal('')
  let upMsgTimer: ReturnType<typeof setTimeout> | undefined
  const setUpFlash = (s: string, ms = 2600): void => {
    setUpMsg(s)
    if (upMsgTimer) clearTimeout(upMsgTimer)
    upMsgTimer = setTimeout(() => setUpMsg(''), ms)
  }
  onMount(() => {
    window.api.on('updater:progress', p => setUpPct(p as number))
    window.api.on('updater:done', d => {
      const info = d as { relaunching?: boolean; version?: string; error?: string }
      if (info.relaunching) setUpState('restarting')
      else { setUpState('idle'); setUpFlash(info.error ?? 'update failed') }
    })
  })
  const updClick = async (): Promise<void> => {
    const st = upState()
    if (st === 'ready') {
      setUpState('downloading')
      const r = await window.api.updaterApply()
      if (!r.started) { setUpState('idle'); setUpFlash(r.error ?? 'failed') }
      return
    }
    if (st !== 'idle') return
    setUpState('checking')
    const c = await window.api.updaterCheck()
    if (c.dev) { setUpState('idle'); setUpFlash('dev build, update via git + npm'); return }
    if (c.updateAvailable) { setUpLatest(c.latest ?? ''); setUpState('ready'); return }
    setUpState('idle')
    setUpFlash(c.error ? 'update check failed' : `v${c.current} up to date`)
  }
  const m = (): Metrics => metrics() ?? { tokPerSec: null, latencyMs: null, totalTokens: 0, contextUsed: 0, contextLimit: 1, costUsd: 0, modelId: model().modelId, provider: model().provider }
  const scrollToBottom = (): void => { queueMicrotask(() => { if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight }) }
  const showToast = (t: string): void => { setToast(t); setTimeout(() => setToast(''), 2500) }
  const contextPct = createMemo(() => Math.min(100, Math.round((m().contextUsed / Math.max(1, m().contextLimit)) * 100)))
  const barClass = createMemo(() => contextPct() > 85 ? 'critical' : contextPct() > 65 ? 'warn' : '')

  const [modelMenuOpen, setModelMenuOpen] = createSignal(false)
  const [mmSources, setMmSources] = createSignal<Array<{ source: string; kind: string; baseUrl: string; host: string; models: Array<{ id: string; sizeGb?: number }> }>>([])
  const [mmBusy, setMmBusy] = createSignal(false)
  const [mmSwitching, setMmSwitching] = createSignal(false)
  const toggleModelMenu = (): void => {
    const next = !modelMenuOpen()
    setModelMenuOpen(next)
    if (next) {
      setMmBusy(true)
      void window.api.discoverModels().then(s => { setMmSources(s); setMmBusy(false) })
    }
  }
  const switchModel = async (s: { kind: string; baseUrl: string; host: string; source: string }, mo: { id: string }): Promise<void> => {
    if (mmSwitching()) return
    setMmSwitching(true)
    try {
      const patch = s.kind === 'ollama'
        ? { provider: 'ollama', baseUrl: s.baseUrl, modelId: mo.id, ollamaUrl: s.host }
        : { provider: 'openai-completions', baseUrl: s.baseUrl, modelId: mo.id }
      await window.api.setProvider(patch)
      const c = await window.api.getConfig()
      if (c) setModel({ modelId: c.modelId, provider: c.provider })
      showToast('Switched to ' + mo.id + ' · ' + s.source.split(' · ')[0])
    } finally {
      setMmSwitching(false)
      setModelMenuOpen(false)
    }
  }

  const refreshSessions = async (): Promise<void> => {
    const list = await window.api.listSessions()
    setSessions(list.filter(s => s.messageCount > 0 || s.id === activeSession()))
  }

  onMount(async () => {
    const searchKeyHandler = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch() }
      if (e.key === 'Escape') {
        if (searchOpen()) setSearchOpen(false)
        if (modelMenuOpen()) setModelMenuOpen(false)
      }
    }
    document.addEventListener('keydown', searchKeyHandler)
    onCleanup(() => document.removeEventListener('keydown', searchKeyHandler))
    const cfg = await window.api.getConfig()
    if (cfg) setModel({ modelId: cfg.modelId, provider: cfg.provider })
    const welcome = await window.api.getWelcome()
    if (welcome) {
      setMessages(arr => [...arr, { id: uid(), role: 'assistant', content: welcome, ts: Date.now() }])
    }
    const wcfg = await window.api.wizardConfig()
    setWizard(wcfg)
    if (!wcfg?.apiKeySet && wcfg?.provider !== 'ollama' && wcfg?.provider !== 'llama.cpp') setFirstRun(true)
    await refreshSessions()
    const metTimer = setInterval(async () => {
      const latest = await window.api.metrics()
      if (latest) setMetrics(latest)
    }, 700)
    onCleanup(() => clearInterval(metTimer))

    const unsubs = [
      window.api.on('session:new', (p) => {
        const d = p as { id: string; name: string }
        setActiveSession(d.id); setSessionName(d.name)
        setMessages([]); setToolCards([]); setStreamingAssistant(''); setStreaming(false)
        void refreshSessions()
      }),
      window.api.on('session:open', (p) => {
        const d = p as { id: string; name: string; messages: Array<{ role: string; content: string; timestamp: number; toolCalls: string | null; error: string | null }> }
        setActiveSession(d.id); setSessionName(d.name)
        const restored: Msg[] = d.messages.map(msg => ({
          id: uid(), role: msg.role as 'user' | 'assistant', content: msg.content, ts: msg.timestamp,
          toolCalls: msg.toolCalls ? (JSON.parse(msg.toolCalls) as ToolCall[]) : undefined,
          error: msg.error ?? undefined
        }))
        setMessages(restored); setToolCards([]); scrollToBottom()
      }),
      window.api.on('pi:user-message', (p) => {
        const d = p as { text: string }
        setMessages(arr => [...arr, { id: uid(), role: 'user', content: d.text, ts: Date.now() }])
        setStreaming(true); setStreamingAssistant(''); setToolCards([])
        streamMsgId = uid()
        scrollToBottom()
      }),
      window.api.on('pi:text-delta', (p) => {
        const d = p as { delta: string }
        setStreamingAssistant(a => a + d.delta)
        scrollToBottom()
      }),
      window.api.on('pi:tool-start', (p) => {
        const d = p as { toolCallId: string; toolName: string; args: Record<string, unknown> }
        setToolCards(c => [...c, { ...d, running: true }])
        scrollToBottom()
      }),
      window.api.on('pi:tool-update', (p) => {
        const d = p as { toolCallId: string; partial: string }
        setToolCards(c => c.map(t => t.toolCallId === d.toolCallId ? { ...t, result: (t.result ?? '') + d.partial } : t))
      }),
      window.api.on('pi:tool-end', (p) => {
        const d = p as { toolCallId: string; result: string; isError: boolean }
        setToolCards(c => c.map(t => t.toolCallId === d.toolCallId ? { ...t, result: d.result.length > 800 ? d.result.slice(0, 800) + '…' : d.result, running: false, isError: d.isError } : t))
      }),
      window.api.on('pi:message-end', () => {
        setMessages(arr => [...arr, { id: streamMsgId || uid(), role: 'assistant', content: streamingAssistant(), ts: Date.now() }])
        setStreamingAssistant(''); setStreaming(false)
        scrollToBottom()
      }),
      window.api.on('pi:error', (p) => {
        const d = p as { message: string }
        setMessages(arr => [...arr, { id: uid(), role: 'assistant', content: '', ts: Date.now(), error: d.message }])
        setStreaming(false); setStreamingAssistant('')
      }),
      window.api.on('ui:confirm-request', (p) => {
        setUiRequests(r => [...r, p as UiRequest])
      }),
      window.api.on('ui:select-request', (p) => {
        setUiRequests(r => [...r, p as UiRequest])
      }),
      window.api.on('ui:input-request', (p) => {
        setUiRequests(r => [...r, p as UiRequest])
      }),
      window.api.on('pi:welcome', (p) => {
        const d = p as { text: string }
        setMessages(arr => [...arr, { id: uid(), role: 'assistant', content: d.text, ts: Date.now() }])
      }),
      window.api.on('pi:regenerate-start', () => {
        setStreaming(true); setStreamingAssistant(''); setToolCards([]); streamMsgId = uid()
        // drop trailing assistant message; the new one replaces it
        setMessages(arr => {
          const copy = [...arr]
          if (copy.length > 0 && copy[copy.length - 1].role === 'assistant') copy.pop()
          return copy
        })
      })
    ]
    onCleanup(() => unsubs.forEach(u => u()))
  })

  const send = async (): Promise<void> => {
    let text = input().trim()
    if (!text && pastedChips().length === 0) return
    if (pastedChips().length > 0) {
      const refs = pastedChips().map(c => `[file attached: ${c.path}]`).join(' ')
      text = (text ? text + '\n\n' : '') + refs
      setPastedChips([])
    }
    setInput('')
    if (streaming()) {
      const r = await window.api.steer(text)
      if (!r.ok) showToast(r.error ?? 'could not send')
      else setMessages(arr => [...arr, { id: uid(), role: 'user', content: text, ts: Date.now() }])
      return
    }
    const r = await window.api.sendPrompt(text)
    if (!r.ok) showToast(r.error ?? 'send failed')
  }

  const retryLast = async (): Promise<void> => {
    const msgArr = messages()
    const last = msgArr[msgArr.length - 1]
    if (last?.error) {
      const lastUser = [...msgArr].reverse().find(msg => msg.role === 'user')
      if (!lastUser) return
      setInput(lastUser.content)
      const arr = msgArr.slice()
      if (arr.length > 0 && arr[arr.length - 1].error) arr.pop()
      setMessages(arr)
      void window.api.sendPrompt(lastUser.content)
      return
    }
    void window.api.regenerate()
  }

  const openSession = async (id: string): Promise<void> => {
    if (id === activeSession()) return
    const ok = await window.api.openSession(id)
    if (!ok) showToast('session has no transcript to replay')
  }

  const deleteSession = async (id: string): Promise<void> => {
    await window.api.deleteSession(id)
    if (id === activeSession()) await window.api.newSession()
    await refreshSessions()
  }

  const resolveUi = async (req: UiRequest, answer: boolean | string | undefined): Promise<void> => {
    setUiRequests(r => r.filter(x => x.id !== req.id))
    if (req.options) await window.api.answerSelect(req.id, answer as string | undefined)
    else if (req.placeholder !== undefined) await window.api.answerInput(req.id, answer as string | undefined)
    else await window.api.answerConfirm(req.id, answer === true)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
  }

  const PASTE_INLINE_MAX = 48000 // context-flood cap: under this, inline fence; over, saved to inbox
  const savePaste = async (content: string, ext: string, name: string): Promise<void> => {
    const r = await window.api.savePaste(content, ext)
    const shortRef = `see attached file ${name}`
    setPastedChips(c => [...c, { name, path: r.path, ref: shortRef }])
  }

  const handlePaste = async (e: ClipboardEvent): Promise<void> => {
    const text = e.clipboardData?.getData('text/plain') ?? ''
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.length > 0) {
      e.preventDefault()
      for (const f of files) {
        const ext = (f.name.split('.').pop() ?? 'txt').toLowerCase()
        const content = await f.text()
        await savePaste(content, ext, f.name)
      }
      return
    }
    if (text.length > PASTE_INLINE_MAX) {
      e.preventDefault()
      await savePaste(text, 'txt', 'pasted.txt')
      setInput(cur => (cur ? cur + '\n' : '') + '[large paste saved; ask the agent to read ' + text.length.toLocaleString() + ' chars from the inbox]')
      return
    }
    // normal paste; small pastes stay inline with the message
  }

  const currentUi = (): UiRequest | undefined => uiRequests()[0]

  return (
    <div class="app">
      <header class="header">
        <img class="logo" src={vulktekLogo} alt="Vulktek" />
        <div class="brand-block">
          <span class="brand"><span class="brand-e">e</span>uler&rsquo;s&nbsp;<span class="brand-h">Harness</span></span>
          <span class="brand-sub">by Vulktek Cyber Solutions</span>
        </div>
        <div class="session-bar">
          <span class="session-name" onDblClick={async () => {
            const name = prompt('Session name', sessionName())
            if (name) { setSessionName(name); await window.api.renameSession(activeSession(), name); await refreshSessions() }
          }} title="Double-click to rename">{sessionName()}</span>
          <button class="icon-btn" title="New chat" onClick={() => void window.api.newSession()}>⟳</button>
          <button class="icon-btn cog" title="Settings" onClick={() => setWizardOpen(true)}>⚙</button>
          <span class="model-chip" title="All local models — click to switch" onClick={() => toggleModelMenu()}>{m().modelId} · {m().provider}</span>
        </div>
      </header>

      <div class="body">
        <aside class="sidebar">
          <h3>Sessions</h3>
          <For each={sessions()}>{(s) =>
            <div class="session-row" classList={{ active: s.id === activeSession() }}>
              <span class="session-item" onClick={() => void openSession(s.id)}>{s.name}</span>
              <button class="session-del" title="Delete" onClick={() => void deleteSession(s.id)}>×</button>
            </div>
          }</For>
        </aside>

        <section class="chat">
          <div class="messages" ref={messagesEl}>
            <For each={messages()}>{(msg, idx) =>
              <div class={`msg ${msg.role}`} classList={{ last: idx() === messages().length - 1 }}>
                <Show when={msg.role === 'user'} fallback={
                  <div>
                    <div class="msg-actions">
                      <button class="regen-btn" title="Regenerate" onClick={() => void window.api.regenerate()}>⟳</button>
                    </div>
                    <Show when={msg.content !== ''}><div class="md" innerHTML={md(msg.content)} /></Show>
                    <Show when={msg.error}>
                      <div class="msg-error">
                        <span>{msg.error}</span>
                        <Show when={msg.error?.includes('retrying') === false}>
                          <button class="retry-btn" onClick={() => void retryLast()}>Retry</button>
                        </Show>
                      </div>
                    </Show>
                  </div>
                }>
                  <div>{msg.content}</div>
                </Show>
              </div>
            }</For>

            <Show when={streaming()}>
              <div class="msg assistant">
                <Switch>
                  <Match when={toolCards().length > 0 && streamingAssistant() === ''}>
                    <For each={toolCards()}>{(t) =>
                      <div class="tool-card" classList={{ running: t.running === true, error: t.isError === true }}>
                        <div class="tool-name">{t.running ? '▸ ' : '✓ '}{t.toolName}</div>
                        <div class="tool-args">{JSON.stringify(t.args).slice(0, 200)}</div>
                        <Show when={t.result}><div class="tool-result">{t.result}</div></Show>
                      </div>
                    }</For>
                  </Match>
                  <Match when={true}>
                    <div class="md" innerHTML={md(streamingAssistant())} />
                    <span class="typing-cursor" />
                  </Match>
                </Switch>
              </div>
            </Show>
          </div>

          <div class="statusline">
            <span class="metric">tok/s <b>{m().tokPerSec ?? '—'}</b></span>
            <span class="metric">latency <b>{m().latencyMs !== null ? m().latencyMs + 'ms' : '—'}</b></span>
            <span class="metric">context <b>{(m().totalTokens / 1000).toFixed(1)}</b></span>
            <div class="context-bar-wrap">
              <div class={`context-bar ${barClass()}`}><span style={{ width: `${contextPct()}%` }} /></div>
              <span>{contextPct()}%</span>
            </div>
            <Show when={contextPct() > 85}>
              <button class="compact-btn" onClick={() => void window.api.compact()}>Compact now</button>
            </Show>
            <span class={`upd-chip upd-${upState()}`} title="Check for updates" onClick={() => void updClick()}>
              {upState() === 'idle' ? (upMsg() || 'update') : upState() === 'checking' ? 'checking…' : upState() === 'ready' ? `update v${upLatest()}` : upState() === 'downloading' ? `${upPct()}%` : 'restarting…'}
            </span>
          </div>

          <Show when={pastedChips().length > 0}>
            <div class="chips">
              <For each={pastedChips()}>{(c) =>
                <span class="chip">{c.name} <button onClick={() => setPastedChips(ch => ch.filter(x => x.path !== c.path))}>×</button></span>
              }</For>
            </div>
          </Show>
          <div class="inputrow">
            <textarea
              onPaste={(e) => { e.stopPropagation(); void handlePaste(e as unknown as ClipboardEvent) }}
              placeholder={streaming() ? 'steering: your message lands after the current tool call…' : 'ask anything — it can read files, run code, edit'}
              value={input()}
              onInput={e => setInput(e.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
            <Show when={!streaming()} fallback={<button class="stop-btn" onClick={() => void window.api.abort()}>■ Stop</button>}>
              <button class="send-btn" onClick={() => void send()}>Send</button>
            </Show>
          </div>
        </section>

        <aside class="activity">
          <h3>Activity</h3>
          <For each={toolCards()}>{(t) =>
            <div class="tool-card" classList={{ running: t.running === true, error: t.isError === true }}>
              <div class="tool-name">{t.running ? '▸ ' : '✓ '}{t.toolName}</div>
              <div class="tool-args">{JSON.stringify(t.args).slice(0, 200)}</div>
              <Show when={t.result}><div class="tool-result">{t.result}</div></Show>
            </div>
          }</For>
          <Show when={toolCards().length === 0}>
            <div style={{ color: 'var(--text-dim)', 'font-size': '12px' }}>tools and files used by the current prompt appear here live</div>
          </Show>
        </aside>
      </div>

      {/* Approval modal */}
      <Show when={currentUi()}>
        {(req) => (
          <div class="ui-modal-overlay">
            <div class="ui-modal">
              <div class="ui-modal-title">{req().title}</div>
              <Show when={req().message}><div class="ui-modal-message">{req().message}</div></Show>
              <Show when={req().options} fallback={
                <div class="ui-modal-inputs">
                  <Show when={req().placeholder !== undefined}>
                    <input class="wizard-input" value={uiAnswer()} onInput={e => setUiAnswer(e.currentTarget.value)} />
                  </Show>
                  <div class="ui-modal-btns">
                    <button class="wizard-back" onClick={() => { void resolveUi(req(), req().placeholder !== undefined ? undefined : false); setUiAnswer('') }}>
                      {req().placeholder !== undefined ? 'Cancel' : 'Deny'}
                    </button>
                    <button class="wizard-next" onClick={() => { void resolveUi(req(), req().placeholder !== undefined ? uiAnswer() : true); setUiAnswer('') }}>
                      {req().placeholder !== undefined ? 'Submit' : 'Allow'}
                    </button>
                  </div>
                </div>
              }>
                <div class="ui-modal-options">
                  <For each={req().options}>{(opt) =>
                    <button class="wizard-preset" onClick={() => void resolveUi(req(), opt)}>{opt}</button>
                  }</For>
                </div>
              </Show>
            </div>
          </div>
        )}
      </Show>

      {/* Wizard overlay (first run or via settings) */}
      <Show when={wizardOpen() || firstRun()}>
        <Wizard config={wizard()} firstRun={firstRun()} onDone={() => {
          setWizardOpen(false); setFirstRun(false)
          void window.api.getConfig().then(c => { if (c) setModel({ modelId: c.modelId, provider: c.provider }) })
          window.location.reload()
        }} />
      </Show>

      {/* Model menu: click the header chip */}
      <Show when={modelMenuOpen()}>
        <div class="menu-scrim" onClick={() => setModelMenuOpen(false)}>
          <div class="model-menu" onClick={e => e.stopPropagation()}>
            <Show when={mmBusy()}>
              <div class="mm-empty">Scanning local model servers (ollama, vLLM, llama.cpp, LM Studio)...</div>
            </Show>
            <Show when={!mmBusy()}>
              <For each={mmSources()}>{(s) =>
                <div class="mm-group">
                  <div class="mm-source">{s.source}</div>
                  <For each={s.models}>{(mo) =>
                    <div class="mm-model" classList={{ current: mo.id === m().modelId }} onClick={() => void switchModel(s, mo)}>
                      <span>{mo.id}</span>
                      <span class="mm-size">
                        <Show when={mo.id === m().modelId}>current · </Show>
                        <Show when={mo.sizeGb !== undefined}>{mo.sizeGb} GB</Show>
                      </span>
                    </div>
                  }</For>
                </div>
              }</For>
              <Show when={mmSources().length === 0}>
                <div class="mm-empty">No model servers reachable. Start ollama, vLLM, llama.cpp or LM Studio.</div>
              </Show>
            </Show>
          </div>
        </div>
      </Show>

      {/* Ctrl+F search overlay */}
      <Show when={searchOpen()}>
        <div class="search-overlay">
          <div class="search-panel">
            <div class="search-row">
              <input id="euler-search-input" class="wizard-input" placeholder="Search all conversations..."
                value={searchQ()} onInput={e => onSearchInput(e.currentTarget.value)} />
              <button class="icon-btn" onClick={() => setSearchOpen(false)}>×</button>
            </div>
            <div class="search-hits">
              <For each={searchHits()}>{(hit) =>
                <div class="search-hit" onClick={() => void jumpTo(hit)}>
                  <div class="sh-session">{hit.sessionName} · {hit.role}</div>
                  <div class="sh-content">{hit.content}</div>
                </div>
              }</For>
              <Show when={searchQ().length >= 2 && searchHits().length === 0}>
                <div class="search-empty">No matches in this machine&apos;s entire history.</div>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={toast()}><div class="toast">{toast()}</div></Show>
    </div>
  )
}
