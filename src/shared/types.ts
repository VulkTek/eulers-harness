// Shared types between main and renderer. Single source of truth for IPC shapes.
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  toolCalls?: ToolCallSummary[]
  error?: string
}

export interface ToolCallSummary {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  result?: string
  isError?: boolean
}

export interface StreamEvent {
  type: 'text-delta' | 'message-end' | 'tool-start' | 'tool-update' | 'tool-end' | 'run-settled' | 'error'
  [key: string]: unknown
}

export interface SessionMeta {
  id: string
  name: string
  createdAt: number
  lastActive: number
  messageCount: number
}

export interface Metrics {
  tokPerSec: number | null
  latencyMs: number | null
  totalTokens: number
  contextUsed: number
  contextLimit: number
  costUsd: number
  modelId: string
  provider: string
}

export interface HarnessConfig {
  provider: string
  baseUrl: string
  apiKeySet: boolean
  modelId: string
  contextLimit: number
  ollamaUrl: string
  workspaceDir: string
  apiKeyPlain?: string
  embedUrl?: string
  ragDocsDir?: string
  thinkingLevel?: string
}
