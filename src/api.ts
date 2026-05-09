export type ModelItem = {
  id: string
  object?: string
  owned_by?: string
  enabled?: boolean
}

export type ModelsResponse = {
  object: 'list'
  data: ModelItem[]
}

export type UpdateModelEnabledResponse = {
  id: string
  object?: string
  created?: string
  owned_by?: string
  enabled: boolean
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ChatCompletionRequest = {
  model: string
  messages: ChatMessage[]
  stream: boolean
  temperature: number
}

export type ChatCompletionResponse = {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message?: ChatMessage
    delta?: Partial<ChatMessage> & { content?: string }
    finish_reason?: string
  }>
}

export type FileObject = {
  id: string
  object?: 'file' | string
  bytes: number
  created_at: number
  filename: string
  purpose: string
}

export type FileListResponse = {
  object: 'list'
  data: FileObject[]
}

export type FileDeleteResponse = {
  id: string
  object?: 'file' | string
  deleted: boolean
}

const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() || ''
const apiToken = (import.meta.env.VITE_API_TOKEN as string | undefined)?.trim() || 'test-token'

function buildUrl(path: string) {
  if (!baseUrl) return path
  return baseUrl.replace(/\/$/, '') + path
}

function buildAuthHeaders(headers?: HeadersInit) {
  const merged = new Headers(headers)
  merged.set('Authorization', `Bearer ${apiToken}`)
  return merged
}

async function readResponseAsJsonOrText(resp: Response): Promise<{ json?: any; text?: string }> {
  const contentType = resp.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      return { json: await resp.json() }
    } catch {
      // fall through to text
    }
  }
  try {
    const text = await resp.text()
    return { text }
  } catch {
    return { text: '' }
  }
}

function extractErrorMessage(parsed: { json?: any; text?: string }, fallback: string) {
  return parsed.json?.error?.message || parsed.json?.message || parsed.text?.trim() || fallback
}

function explainNonJson(text: string | undefined, status: number) {
  const head = (text || '').trim().slice(0, 80)
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<html')) {
    return `接口返回了 HTML（可能是前端服务的 index.html），请检查是否使用了 Vite 代理/或配置了 VITE_API_BASE_URL（status=${status}）`
  }
  return `接口返回非 JSON 内容（status=${status}）`
}

async function requestJson<T>(path: string, init: RequestInit, fallbackError: string): Promise<T> {
  const resp = await fetch(buildUrl(path), {
    ...init,
    headers: buildAuthHeaders(init.headers),
  })
  const parsed = await readResponseAsJsonOrText(resp)
  if (!resp.ok) {
    throw new Error(extractErrorMessage(parsed, `${fallbackError} (${resp.status})`))
  }
  if (!parsed.json) {
    throw new Error(explainNonJson(parsed.text, resp.status))
  }
  return parsed.json as T
}

export async function fetchModels(): Promise<ModelsResponse> {
  return requestJson<ModelsResponse>('/v1/models', {
    method: 'GET',
  }, 'Fetch models failed')
}

export async function uploadFile(file: File, purpose: string): Promise<FileObject> {
  const form = new FormData()
  form.append('file', file)
  if (purpose != null) form.append('purpose', String(purpose))

  const resp = await fetch(buildUrl('/v1/files'), {
    method: 'POST',
    headers: buildAuthHeaders(),
    body: form,
  })

  const parsed = await readResponseAsJsonOrText(resp)
  if (!resp.ok) {
    throw new Error(extractErrorMessage(parsed, `Upload file failed (${resp.status})`))
  }
  if (!parsed.json) {
    throw new Error(explainNonJson(parsed.text, resp.status))
  }
  return parsed.json as FileObject
}

export async function fetchFiles(): Promise<FileListResponse> {
  return requestJson<FileListResponse>('/v1/files', {
    method: 'GET',
  }, 'Fetch files failed')
}

export async function fetchFileMeta(fileId: string): Promise<FileObject> {
  return requestJson<FileObject>(`/v1/files/${encodeURIComponent(fileId)}`, {
    method: 'GET',
  }, 'Fetch file failed')
}

export async function deleteFile(fileId: string): Promise<FileDeleteResponse> {
  return requestJson<FileDeleteResponse>(`/v1/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
  }, 'Delete file failed')
}

// fetchAllModels returns all models (enabled=0/1) for admin/model-management UI.
export async function fetchAllModels(): Promise<ModelsResponse> {
  return requestJson<ModelsResponse>('/v1/admin/models', {
    method: 'GET',
  }, 'Fetch all models failed')
}

export async function updateModelEnabled(modelId: string, enabled: boolean): Promise<UpdateModelEnabledResponse> {
  return requestJson<UpdateModelEnabledResponse>(`/v1/admin/models/${encodeURIComponent(modelId)}`, {
    method: 'PATCH',
    headers: buildAuthHeaders({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({ enabled }),
  }, 'Update model failed')
}

export async function createChatCompletionNonStream(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  return requestJson<ChatCompletionResponse>('/v1/chat/completions', {
    method: 'POST',
    headers: buildAuthHeaders({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({ ...req, stream: false }),
  }, 'Request failed')
}

// Minimal SSE parser: reads `data: ...` lines and calls onChunk with parsed JSON.
export async function createChatCompletionStream(
  req: ChatCompletionRequest,
  onDelta: (textDelta: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch(buildUrl('/v1/chat/completions'), {
    method: 'POST',
    headers: buildAuthHeaders({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({ ...req, stream: true }),
    signal,
  })

  if (!resp.ok) {
    const parsed = await readResponseAsJsonOrText(resp)
    const msg = parsed.json?.error?.message || parsed.json?.message
    throw new Error(msg || parsed.text?.trim() || `Request failed (${resp.status})`)
  }

  if (!resp.body) {
    throw new Error('Streaming response body missing')
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: !done })

    // Process line by line; backend/upstream usually separates events with blank lines.
    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const rawLine = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)

      const line = rawLine.trimEnd()
      if (!line) continue
      if (!line.startsWith('data:')) continue

      const payload = line.replace(/^data:\s*/, '')
      if (payload === '[DONE]') {
        return
      }

      try {
        const obj = JSON.parse(payload) as ChatCompletionResponse
        const delta = obj?.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta.length > 0) {
          onDelta(delta)
        }
      } catch {
        // ignore malformed chunks
      }
    }

    if (done) break
  }
}
