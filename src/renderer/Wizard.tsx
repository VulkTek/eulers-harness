// P4: first-run wizard + provider settings. Full-screen overlay, dark amber/ash.
import { createSignal, Show, For, onMount, onCleanup } from 'solid-js'
import { DEMO_SESSIONS } from './demo'
import vulktekLogo from './vulktek-logo-lockup.png'

type WizardStep = 'provider' | 'endpoint' | 'model' | 'workspace' | 'rag' | 'done' 

export interface WizardConfig {
  provider: string
  baseUrl: string
  apiKeySet: boolean
  modelId: string
  contextLimit: number
  workspaceDir: string
  embedUrl?: string
  ragDocsDir?: string
  ollamaUrl?: string
}

const window2md = (text: string): string => {
  const div = document.createElement('div')
  div.innerHTML = window.__eulerMarked ? window.__eulerMarked(text) : '<div style="white-space:pre-wrap">' + text.replace(/</g, '&lt;') + '</div>'
  return div.innerHTML
}

const PROVIDER_PRESETS = [
  { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false, hint: 'Local models on this machine. Nothing leaves the house.' },
  { id: 'llama.cpp', label: 'llama.cpp server (local GPU)', baseUrl: 'http://127.0.0.1:8080/v1', needsKey: false, hint: 'Point at a llama-server you run yourself.' },
  { id: 'openai-completions', label: 'OpenAI-compatible (API key)', baseUrl: 'https://api.openai.com/v1', needsKey: true, hint: 'Works for any OpenAI-style endpoint: OpenAI, Groq, Together, vLLM cloud...' },
  { id: 'anthropic', label: 'Anthropic (API key)', baseUrl: 'https://api.anthropic.com/v1', needsKey: true, hint: 'Claude models with your own key.' }
]

export function Wizard(props: { config: WizardConfig | null; onDone: () => void; firstRun: boolean }) {
  const [step, setStep] = createSignal<WizardStep>('provider')
  const [provider, setProvider] = createSignal(props.config?.provider ?? 'ollama')
  const [baseUrl, setBaseUrl] = createSignal(props.config?.baseUrl ?? 'http://127.0.0.1:11434/v1')
  const [ollamaApi, setOllamaApi] = createSignal(props.config?.ollamaUrl ?? (props.config?.baseUrl ?? 'http://127.0.0.1:11434/v1').replace(/\/v1$/, ''))
  const [ollamaTouched, setOllamaTouched] = createSignal(false)
  const [apiKey, setApiKey] = createSignal('')
  const [models, setModels] = createSignal<string[]>([])
  const [modelId, setModelId] = createSignal(props.config?.modelId ?? '')
  const [contextLimit, setContextLimit] = createSignal(props.config?.contextLimit ?? 40960)
  const [workspaceDir, setWorkspaceDir] = createSignal(props.config?.workspaceDir ?? '')
  const [embedUrl, setEmbedUrl] = createSignal(props.config?.embedUrl ?? '')
  const [ragDocsDir, setRagDocsDir] = createSignal(props.config?.ragDocsDir ?? '')
  const [probeState, setProbeState] = createSignal<'idle' | 'probing' | 'ok' | 'fail'>('idle')
  const [probeWarn, setProbeWarn] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [err, setErr] = createSignal('')
  const [ragProg, setRagProg] = createSignal('')
  const [pullQ, setPullQ] = createSignal('')
  const [pullProg, setPullProg] = createSignal('')
  const [pullBusy, setPullBusy] = createSignal(false)

  const doIndex = async (): Promise<void> => {
    setRagProg('Indexing...')
    const r = await window.api.indexRag(ragDocsDir(), embedUrl())
    setRagProg(r.ok ? 'Indexed ' + r.chunks + ' chunks from ' + r.files + ' files' : 'Failed: ' + (r.error ?? ''))
  }
  const doExport = async (): Promise<void> => {
    setRagProg('Exporting...')
    const r = await window.api.exportData()
    setRagProg(r.ok ? 'Exported to ' + r.path : 'Export failed')
  }
  const doWipe = async (): Promise<void> => {
    const r = await window.api.wipeData()
    setRagProg(r.ok ? 'Data wiped. Sessions, indexes and agent extensions cleared.' : 'Wipe failed')
    if (r.ok) setTimeout(() => window.location.reload(), 1200)
  }

  const preset = () => PROVIDER_PRESETS.find(p => p.id === provider())

  const pickProvider = (id: string): void => {
    setProvider(id)
    const p = PROVIDER_PRESETS.find(x => x.id === id)
    if (p) {
      setBaseUrl(p.baseUrl)
      if (id === 'ollama' && !ollamaTouched()) setOllamaApi(p.baseUrl.replace(/\/v1$/, ''))
    }
  }

  const probe = async (): Promise<void> => {
    setProbeState('probing')
    const r = await window.api.probeEndpoint(baseUrl(), apiKey() || undefined, provider() === 'ollama' ? ollamaApi() || undefined : undefined)
    if (r.reachable && r.models.length > 0) {
      setModels(r.models)
      if (!r.models.includes(modelId())) setModelId(r.models[0])
      setProbeWarn(r.ollamaApiOk === false)
      setProbeState('ok')
    } else {
      setProbeState('fail')
    }
  }
  const onOllamaApiInput = (v: string): void => {
    const api = v.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
    setOllamaApi(api)
    setOllamaTouched(true)
    if (provider() === 'ollama' && api) setBaseUrl(api + '/v1')
  }

  const finish = async (): Promise<void> => {
    setSaving(true)
    setErr('')
    const patch: Record<string, unknown> = {
      provider: provider(),
      baseUrl: baseUrl(),
      ...(provider() === 'ollama' && ollamaApi() ? { ollamaUrl: ollamaApi() } : {}),
      modelId: modelId(),
      contextLimit: contextLimit(),
      workspaceDir: workspaceDir() || undefined,
      embedUrl: embedUrl() || undefined,
      ragDocsDir: ragDocsDir() || undefined
    }
    if (apiKey()) patch.apiKey = apiKey()
    const r = await window.api.setProvider(patch)
    setSaving(false)
    if (r.ok !== false) {
      if (props.firstRun) {
        props.onDone()
      } else {
        setStep('done')
      }
    } else {
      setErr('could not start session with this configuration')
    }
  }

  const skipRag = (): void => {
    setEmbedUrl(''); setRagDocsDir('')
    void finish()
  }

  const doPull = async (): Promise<void> => {
    const name = pullQ().trim()
    if (!name) return
    setPullBusy(true)
    setPullProg('Pulling ' + name + '...')
    const r = await window.api.pullModel(name, ollamaApi() || undefined)
    if (r.ok) {
      setPullProg('Pulled ' + name + '. Model list refreshed.')
      await probe()
    } else {
      setPullProg(r.error === 'cancelled' ? 'Pull cancelled.' : 'Pull failed: ' + (r.error ?? 'unknown'))
    }
    setPullBusy(false)
  }

  onMount(() => {
    const off = window.api.on('ollama:pull', (p) => {
      const d = p as { model: string; status: string; pct?: number }
      if (d.model !== pullQ().trim()) return
      setPullProg(d.status + (d.pct !== undefined ? ' ' + d.pct + '%' : ''))
    })
    onCleanup(off)
  })

  return (
    <div class="wizard-overlay">
      <div class="wizard">
        <Show when={!props.firstRun}>
          <button class="icon-btn wizard-close" title="Close setup" onClick={() => props.onDone()}>×</button>
        </Show>
        <img src={vulktekLogo} alt="Vulktek" />
        <h1><span class="brand-e">e</span>uler&rsquo;s Harness <em>setup</em></h1>
        <p class="wizard-sub">Plug in a provider, pick a model, and you are running.</p>

        <Show when={step() === 'provider'}>
          <div class="wizard-step">
            <label class="wizard-label">Where do your models come from?</label>
            <Show when={props.firstRun}>
              <div class="demo-preview">
                <div class="demo-title">What it looks like in action</div>
                <For each={DEMO_SESSIONS}>{(ds) =>
                  <div class="demo-session">
                    <div class="demo-session-name">{ds.name}</div>
                    <For each={ds.messages.slice(0, 2)}>{(msg) =>
                      <div class={`demo-msg ${msg.role}`}>
                        <div class="md" innerHTML={msg.content.startsWith('```') || msg.content.includes('\n```') ? window2md(msg.content) : msg.content} />
                      </div>
                    }</For>
                  </div>
                }</For>
              </div>
            </Show>
            <For each={PROVIDER_PRESETS}>{(p) =>
              <div class="wizard-preset" classList={{ selected: provider() === p.id }} onClick={() => pickProvider(p.id)}>
                <div class="wp-label">{p.label}</div>
                <div class="wp-hint">{p.hint}</div>
              </div>
            }</For>
            <button class="wizard-next" onClick={() => setStep('endpoint')}>Next</button>
          </div>
        </Show>

        <Show when={step() === 'endpoint'}>
          <div class="wizard-step">
            <label class="wizard-label">Endpoint URL</label>
            <input class="wizard-input" value={baseUrl()} onInput={e => { setBaseUrl(e.currentTarget.value); if (provider() === 'ollama' && !ollamaTouched()) setOllamaApi(e.currentTarget.value.replace(/\/+$/, '').replace(/\/v1$/, '')) }} placeholder="http://..." />
            <Show when={provider() === 'ollama'}>
              <label class="wizard-label">Ollama API</label>
              <input class="wizard-input" id="euler-ollama-api" value={ollamaApi()} onInput={e => onOllamaApiInput(e.currentTarget.value)} placeholder="http://127.0.0.1:11434" />
              <p class="wizard-hint">Ollama's own API, on this machine or another one on the LAN. Fill this in and the endpoint URL fills itself in (adds /v1), and Test lists what that Ollama serves. Leave default when Ollama runs here.</p>
              <label class="wizard-label">Pull a model</label>
              <input id="euler-ollama-pull" class="wizard-input" value={pullQ()} onInput={e => setPullQ(e.currentTarget.value)} placeholder="model name, e.g. qwen3:14b or llama3.2:3b" />
              <div class="wizard-btns">
                <button class="wizard-next" disabled={pullBusy() || !ollamaApi() || pullQ().trim() === ''} onClick={() => void doPull()}>{pullBusy() ? 'Pulling...' : 'Pull'}</button>
                <Show when={pullBusy()}><button class="wizard-skip" onClick={() => void window.api.cancelPull()}>Cancel</button></Show>
              </div>
              <Show when={pullProg()}><div class="wizard-ok" id="euler-ollama-pull-prog">{pullProg()}</div></Show>
            </Show>
            <Show when={preset()?.needsKey}>
              <label class="wizard-label">API key (encrypted at rest)</label>
              <input class="wizard-input" type="password" value={apiKey()} onInput={e => setApiKey(e.currentTarget.value)} placeholder="sk-..." />
            </Show>
            <button class="wizard-next" disabled={probeState() === 'probing'} onClick={() => void probe()}>
              {probeState() === 'probing' ? 'Checking...' : 'Test connection'}
            </button>
            <Show when={probeState() === 'ok'}><div class="wizard-ok">Found {models().length} models</div></Show>
            <Show when={probeState() === 'ok' && probeWarn()}><div class="wizard-fail">Endpoint answered, but the Ollama API did not — model list may be partial.</div></Show>
            <Show when={probeState() === 'fail'}><div class="wizard-fail">Could not reach endpoint. Check the URL and key.</div></Show>
            <div class="wizard-btns">
              <button class="wizard-back" onClick={() => setStep('provider')}>Back</button>
              <Show when={probeState() === 'ok'}>
                <button class="wizard-next" onClick={() => setStep('model')}>Next</button>
              </Show>
            </div>
          </div>
        </Show>

        <Show when={step() === 'model'}>
          <div class="wizard-step">
            <label class="wizard-label">Pick your model</label>
            <div class="wizard-models">
              <For each={models()}>{(m) =>
                <div class="wizard-model" classList={{ selected: modelId() === m }} onClick={() => setModelId(m)}>{m}</div>
              }</For>
            </div>
            <label class="wizard-label">Context window size (tokens)</label>
            <input class="wizard-input" type="number" value={contextLimit()} onInput={e => setContextLimit(Number(e.currentTarget.value) || 40960)} />
            <div class="wizard-btns">
              <button class="wizard-back" onClick={() => setStep('endpoint')}>Back</button>
              <button class="wizard-next" disabled={!modelId()} onClick={() => setStep('workspace')}>Next</button>
            </div>
          </div>
        </Show>

        <Show when={step() === 'workspace'}>
          <div class="wizard-step">
            <label class="wizard-label">Workspace folder</label>
            <p class="wizard-hint">The folder where the agent works with files. Type a path, e.g. /home/you/projects — Windows: C:\Users\you\projects</p>
            <input class="wizard-input" value={workspaceDir()} onInput={e => setWorkspaceDir(e.currentTarget.value)} />
            <div class="wizard-btns">
              <button class="wizard-back" onClick={() => setStep('model')}>Back</button>
              <button class="wizard-next" onClick={() => setStep('rag')}>Next</button>
            </div>
          </div>
        </Show>

        <Show when={step() === 'rag'}>
          <div class="wizard-step">
            <label class="wizard-label">RAG: your document search (optional)</label>
            <p class="wizard-hint">Point at a folder of docs (txt, md, json, csv, log, html) and an embedding endpoint. Index now or later. The agent gets a search_docs tool for your own files.</p>
            <input class="wizard-input" value={ragDocsDir()} onInput={e => setRagDocsDir(e.currentTarget.value)} placeholder="C:\\Users\\you\\Documents  or  /home/you/docs" />
            <input class="wizard-input" value={embedUrl()} onInput={e => setEmbedUrl(e.currentTarget.value)} placeholder="http://127.0.0.1:11434/v1 (embedded endpoint; model nomic-embed-text)" />
            <div class="wizard-btns">
              <button class="wizard-back" onClick={() => setStep('workspace')}>Back</button>
              <button class="wizard-skip" onClick={() => void skipRag()}>Skip</button>
              <button class="wizard-next" onClick={() => void finish()} disabled={saving()}>Finish</button>
            </div>
            <Show when={err()}><div class="wizard-fail">{err()}</div></Show>
            <div class="wizard-rag-actions">
              <button class="wizard-next" disabled={!ragDocsDir() || !embedUrl()} onClick={() => void doIndex()}>Index now</button>
              <Show when={ragProg()}><div class="wizard-ok">{ragProg()}</div></Show>
            </div>
          </div>
        </Show>

        <Show when={!props.firstRun && step() === 'done'}>
          <div class="wizard-step">
            <label class="wizard-label">Data</label>
            <div class="wizard-btns">
              <button class="wizard-back" onClick={() => void doExport()}>Export all data (.zip)</button>
              <button class="wizard-skip" id="euler-wipe" onClick={() => { if (confirm('Wipe all conversations, sessions and indexes? Config is kept.')) void doWipe() }}>Wipe data</button>
            </div>
            <div class="wizard-btns" style={{ 'justify-content': 'center' }}>
              <button class="wizard-next" onClick={() => props.onDone()}>Done</button>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}