// P4: provider configuration with encrypted API key storage (Electron safeStorage).
import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { HarnessConfig } from '../shared/types'

export interface EulerConfig extends HarnessConfig {
}

const DEFAULTS: EulerConfig = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKeySet: false,
  modelId: 'qwen3:8b',
  contextLimit: 40960,
  ollamaUrl: 'http://127.0.0.1:11434',
  workspaceDir: ''
}

export class ConfigManager {
  private path: string

  constructor(eulerDir: string) {
    this.path = join(eulerDir, 'config.json')
  }

  load(): EulerConfig {
    if (!existsSync(this.path)) return { ...DEFAULTS }
    const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<EulerConfig> & { apiKeyEnc?: string }
    const cfg: EulerConfig = { ...DEFAULTS, ...raw }
    if (raw.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
      try {
        cfg.apiKeyPlain = safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, 'base64'))
        cfg.apiKeySet = true
      } catch { cfg.apiKeySet = false }
    }
    return cfg
  }

  save(cfg: EulerConfig): void {
    const persist: Partial<EulerConfig> & { apiKeyEnc?: string } = { ...cfg }
    // never persist plaintext; encrypt when available
    if (cfg.apiKeyPlain) {
      if (safeStorage.isEncryptionAvailable()) {
        persist.apiKeyEnc = safeStorage.encryptString(cfg.apiKeyPlain).toString('base64')
        persist.apiKeySet = true
      } else {
        // no OS keyring: refuse plaintext persistence
        persist.apiKeySet = false
      }
    }
    delete persist.apiKeyPlain
    writeFileSync(this.path, JSON.stringify(persist, null, 2))
  }
}


