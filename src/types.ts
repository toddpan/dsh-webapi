/**
 * @dsh-external/dsh-web-service - Types & Interfaces
 */

export interface ApiResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: string
  code?: string
  timestamp?: number
}

// ==================== Workspaces ====================

export interface WorkspaceItem {
  id: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: number
  updatedAt: number
}

export interface WorkspaceCreateInput {
  path: string
  title?: string
}

export interface WorkspaceUpdateInput {
  title: string
}

// ==================== Sessions ====================

export interface SessionItem {
  id: string
  title?: string
  createdAt?: number
  updatedAt?: number
  workspaceId?: string
  status?: 'idle' | 'running' | 'error'
  lastActivityAt?: number
  model?: {
    provider: string
    model: string
    reasoningEffort?: string
  }
}

export interface SessionCreateInput {
  workspaceId?: string
  cwd?: string
  title?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  agentPreset?: string
  sessionId?: string
}

export interface SessionUpdateInput {
  title?: string
  provider?: string
  model?: string
  reasoningEffort?: string
}

export interface SessionPromptInput {
  prompt: string
  images?: Array<{
    mimeType: string
    data: string // base64 encoded
  }>
  mode?: 'normal' | 'steer'
  timeoutMs?: number
}

export interface SessionHistoryQuery {
  beforeSeq?: number
  throughSeq?: number
  maxMessages?: number
}

export interface SessionHistoryMessage {
  seq: number
  type: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  reasoning?: string
  toolCalls?: Array<{
    id?: string
    name: string
    arguments: unknown
  }>
  time?: number
}

// ==================== Models & Settings ====================

export interface ModelItem {
  id: string
  provider: string
  name?: string
  description?: string
  contextLimit?: number
  inputModalities?: string[]
  isDefault?: boolean
}

export interface DefaultModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ProviderItem {
  id: string
  displayName?: string
  models: string[]
}

// ==================== OpenAI Compatible ====================

export interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
}

export interface OpenAiChatCompletionRequest {
  model?: string
  messages: OpenAiChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  sessionId?: string // 支持关联已有 session，不传则自动创建临时 session
}

// ==================== Plugin Config ====================

export interface WebServiceConfig {
  /** API 路由前缀，默认 '/api/v1' */
  pathPrefix?: string
  /** 鉴权 Token，若为空则不鉴权 */
  apiKey?: string
  /** 独立监听 HTTP 端口，默认为 0（仅挂载主 webserver）；若 >0 则额外独立监听 */
  standalonePort?: number
  /** 是否开启 CORS，默认 true */
  cors?: boolean
  /** 默认工作空间目录，默认 process.cwd() */
  defaultCwd?: string
}
