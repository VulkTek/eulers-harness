// Preload: typed, allowlisted IPC surface. No nodeIntegration in renderer.
import { contextBridge, ipcRenderer } from 'electron'

const EVENTS = ['pi:text-delta', 'pi:tool-start', 'pi:tool-update', 'pi:tool-end', 'pi:message-end', 'pi:error', 'pi:user-message', 'session:new', 'session:open', 'pi:compaction-start', 'pi:compaction-end', 'pi:regenerate-start', 'pi:welcome', 'ui:confirm-request', 'ui:select-request', 'ui:input-request', 'ui:notify', 'rag:progress', 'ollama:pull']

const apiEventsOn = (channel: string, listener: (...args: unknown[]) => void): (() => void) => {
  const wrapped = (_e: unknown, ...args: unknown[]): void => listener(...args)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api = {
  on: (channel: string, listener: (...args: unknown[]) => void): (() => void) => {
    if (!EVENTS.includes(channel)) throw new Error(`channel not allowed: ${channel}`)
    return apiEventsOn(channel, listener)
  },
  getConfig: () => ipcRenderer.invoke('harness:config'),
  sendPrompt: (text: string) => ipcRenderer.invoke('harness:prompt', text),
  steer: (text: string) => ipcRenderer.invoke('harness:steer', text),
  followUp: (text: string) => ipcRenderer.invoke('harness:follow-up', text),
  abort: () => ipcRenderer.invoke('harness:abort'),
  newSession: () => ipcRenderer.invoke('harness:new-session'),
  listSessions: () => ipcRenderer.invoke('harness:list-sessions'),
  openSession: (id: string) => ipcRenderer.invoke('harness:open-session', id),
  getMessages: (id: string) => ipcRenderer.invoke('harness:get-messages', id),
  renameSession: (id: string, name: string) => ipcRenderer.invoke('harness:rename-session', id, name),
  deleteSession: (id: string) => ipcRenderer.invoke('harness:delete-session', id),
  metrics: () => ipcRenderer.invoke('harness:metrics'),
  getWelcome: () => ipcRenderer.invoke('harness:welcome'),
  search: (query: string) => ipcRenderer.invoke('harness:search', query),
  savePaste: (content: string, ext: string) => ipcRenderer.invoke('harness:save-paste', content, ext),
  onRagProgress: (fn: (p: unknown) => void) => apiEventsOn('rag:progress', fn),
  compact: () => ipcRenderer.invoke('harness:compact'),
  regenerate: () => ipcRenderer.invoke('harness:regenerate'),
  // wizard
  wizardConfig: () => ipcRenderer.invoke('wizard:config'),
  setProvider: (patch: Record<string, unknown>) => ipcRenderer.invoke('wizard:set-provider', patch),
  probeEndpoint: (baseUrl: string, apiKey?: string, ollamaApi?: string) => ipcRenderer.invoke('wizard:probe-endpoint', baseUrl, apiKey, ollamaApi),
  discoverModels: () => ipcRenderer.invoke('models:discover'),
  pullModel: (model: string, ollamaApi?: string) => ipcRenderer.invoke('wizard:ollama-pull', model, ollamaApi),
  cancelPull: () => ipcRenderer.invoke('wizard:ollama-pull-cancel'),
  // self-updater
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterApply: () => ipcRenderer.invoke('updater:apply'),
  ragStatus: () => ipcRenderer.invoke('wizard:rag-status'),
  indexRag: (docsDir: string, embedUrl: string) => ipcRenderer.invoke('wizard:index-rag', docsDir, embedUrl),
  exportData: () => ipcRenderer.invoke('wizard:export'),
  wipeData: () => ipcRenderer.invoke('wizard:wipe'),
  // ui dialog answers
  answerConfirm: (id: string, answer: boolean) => ipcRenderer.invoke('ui:confirm-answer', id, answer),
  answerSelect: (id: string, choice: string | undefined) => ipcRenderer.invoke('ui:select-answer', id, choice),
  answerInput: (id: string, text: string | undefined) => ipcRenderer.invoke('ui:input-answer', id, text)
}

contextBridge.exposeInMainWorld('api', api)
