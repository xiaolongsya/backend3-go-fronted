export type ModelItem = {
  id: string
  object?: string
  owned_by?: string
}

export type ModelsResponse = {
  object: 'list'
  data: ModelItem[]
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

const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() || ''
const apiToken = (import.meta.env.VITE_API_TOKEN as string | undefined)?.trim() || 'xiaolong'

function buildUrl(path: string) {
  if (!baseUrl) return path
  return baseUrl.replace(/\/$/, '') + path
}

export async function fetchModels(): Promise<ModelsResponse> {
  const resp = await fetch(buildUrl('/v1/models'), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  })
  const data = await resp.json()
  if (!resp.ok) {
    throw new Error(data?.error?.message || `Fetch models failed (${resp.status})`)
  }
  return data as ModelsResponse
}

export async function createChatCompletionNonStream(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  const resp = await fetch(buildUrl('/v1/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({ ...req, stream: false }),
  })

  const data = await resp.json()
  if (!resp.ok) {
    throw new Error(data?.error?.message || `Request failed (${resp.status})`)
  }
  return data as ChatCompletionResponse
}

// Minimal SSE parser: reads `data: ...` lines and calls onChunk with parsed JSON.
export async function createChatCompletionStream(
  req: ChatCompletionRequest,
  onDelta: (textDelta: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch(buildUrl('/v1/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({ ...req, stream: true }),
    signal,
  })

  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    throw new Error((data as any)?.error?.message || `Request failed (${resp.status})`)
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
