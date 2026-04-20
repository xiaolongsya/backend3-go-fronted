<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  createChatCompletionNonStream,
  createChatCompletionStream,
  fetchModels,
  type ChatMessage,
  type ModelItem,
} from './api'

type UiMessage = {
  role: 'user' | 'assistant'
  content: string
  think?: string
}

const models = ref<ModelItem[]>([])
const modelMenuOpen = ref(false)
const selectedModelId = ref<string>('')

const streamMode = ref(true)
const inputText = ref('')

const messages = ref<UiMessage[]>([])
const loading = ref(false)
const errorText = ref<string>('')

const listRef = ref<HTMLDivElement | null>(null)
const abortController = ref<AbortController | null>(null)

type ThinkFilterState = {
  inThink: boolean
  carry: string
}

function splitThinkDelta(
  delta: string,
  state: ThinkFilterState,
): { visible: string; think: string } {
  const openTag = '<think>'
  const closeTag = '</think>'

  // Prepend carry for boundary-safe matching
  let text = state.carry + delta
  state.carry = ''

  let visible = ''
  let think = ''
  while (text.length > 0) {
    if (!state.inThink) {
      const start = text.indexOf(openTag)
      if (start === -1) {
        // Keep last chars for boundary matching
        const keepTail = Math.min(openTag.length - 1, text.length)
        const cut = text.length - keepTail
        visible += text.slice(0, cut)
        state.carry = text.slice(cut)
        break
      }

      visible += text.slice(0, start)
      text = text.slice(start + openTag.length)
      state.inThink = true
      continue
    }

    const end = text.indexOf(closeTag)
    if (end === -1) {
      // Keep think content; keep tail for boundary matching
      const keepTail = Math.min(closeTag.length - 1, text.length)
      const cut = text.length - keepTail
      think += text.slice(0, cut)
      state.carry = text.slice(cut)
      break
    }

    // Capture think content, then move past closing tag
    think += text.slice(0, end)
    text = text.slice(end + closeTag.length)
    state.inThink = false
  }

  return { visible, think }
}

function scrollToBottom() {
  // Use nextTick so DOM reflects latest message content.
  nextTick(() => {
    const el = document.querySelector<HTMLElement>('.chat')
    if (!el) return
    el.scrollTop = el.scrollHeight
  })
}

const selectedModelLabel = computed(() => selectedModelId.value || '选择模型')

async function loadModels() {
  errorText.value = ''
  const resp = await fetchModels()
  models.value = resp.data || []
  if (!selectedModelId.value && models.value.length > 0) {
    selectedModelId.value = models.value[0].id
  }
}

function toggleModelMenu() {
  modelMenuOpen.value = !modelMenuOpen.value
  if (modelMenuOpen.value) {
    // lazy load if empty
    if (models.value.length === 0) {
      loadModels().catch((e) => {
        errorText.value = e instanceof Error ? e.message : String(e)
      })
    }
    nextTick(() => listRef.value?.focus())
  }
}

function chooseModel(id: string) {
  selectedModelId.value = id
  modelMenuOpen.value = false
}

function toggleStream() {
  streamMode.value = !streamMode.value
}

function toChatMessagesForRequest(): ChatMessage[] {
  // Convert UI messages to API messages.
  // No system prompt to keep UX minimal.
  return messages.value.map((m) => ({ role: m.role, content: m.content }))
}

async function send() {
  const text = inputText.value.trim()
  if (!text || loading.value) return
  if (!selectedModelId.value) {
    errorText.value = '请先选择模型'
    return
  }

  errorText.value = ''
  loading.value = true

  // push user message
  messages.value.push({ role: 'user', content: text })
  inputText.value = ''

  // build request messages BEFORE adding assistant placeholder
  const requestMessages = toChatMessagesForRequest()

  // create a placeholder assistant message (for both stream & non-stream)
  const assistantIndex = messages.value.push({ role: 'assistant', content: '' }) - 1

  scrollToBottom()

  const req = {
    model: selectedModelId.value,
    messages: requestMessages,
    stream: streamMode.value,
    temperature: 0.7,
  }

  try {
    if (!streamMode.value) {
      const resp = await createChatCompletionNonStream(req)
      const raw = resp?.choices?.[0]?.message?.content ?? ''
      const thinkMatches = Array.from(raw.matchAll(/<think>([\s\S]*?)<\/think>/g)).map((m) => (m[1] || '').trim())
      const thinkText = thinkMatches.filter(Boolean).join('\n\n')
      const visibleText = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

      messages.value[assistantIndex].think = thinkText
      messages.value[assistantIndex].content = visibleText
      scrollToBottom()
      return
    }

    abortController.value?.abort()
    abortController.value = new AbortController()

    const thinkState: ThinkFilterState = { inThink: false, carry: '' }
    let pendingVisible = ''
    let pendingThink = ''
    let rafId: number | null = null

    const flush = () => {
      rafId = null
      if (!pendingVisible && !pendingThink) return
      if (pendingThink) {
        messages.value[assistantIndex].think = (messages.value[assistantIndex].think || '') + pendingThink
        pendingThink = ''
      }
      if (pendingVisible) {
        messages.value[assistantIndex].content += pendingVisible
        pendingVisible = ''
      }
      scrollToBottom()
    }

    const scheduleFlush = () => {
      if (rafId != null) return
      rafId = window.requestAnimationFrame(flush)
    }

    await createChatCompletionStream(
      req,
      (delta) => {
        const parts = splitThinkDelta(delta, thinkState)
        if (parts.think) pendingThink += parts.think
        if (parts.visible) pendingVisible += parts.visible
        if (!parts.think && !parts.visible) return
        scheduleFlush()
      },
      abortController.value.signal,
    )

    // Flush remaining pending text
    if (rafId != null) {
      window.cancelAnimationFrame(rafId)
      rafId = null
    }
    flush()

    // If stream ended, carry might include leftover non-tag text.
    if (thinkState.carry) {
      // carry may include partial tag prefix; only append if it doesn't look like a tag
      if (!/^<\/?think/i.test(thinkState.carry)) {
        if (thinkState.inThink) {
          messages.value[assistantIndex].think = (messages.value[assistantIndex].think || '') + thinkState.carry
        } else {
          messages.value[assistantIndex].content += thinkState.carry
        }
      }
    }
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : String(e)
    // keep assistant message but show error
    if (!messages.value[assistantIndex].content) {
      messages.value[assistantIndex].content = '(请求失败)'
    }
  } finally {
    loading.value = false
  }
}

watch(
  () => messages.value.length,
  () => {
    scrollToBottom()
  },
)

onMounted(() => {
  loadModels().catch((e) => {
    errorText.value = e instanceof Error ? e.message : String(e)
  })
})
</script>

<template>
  <div class="page">
    <div class="card">
      <header class="header">
        <div class="title">AI Chat</div>

        <div class="model">
          <button class="btn" type="button" @click="toggleModelMenu">
            {{ selectedModelLabel }}
          </button>

          <div v-if="modelMenuOpen" class="menu" tabindex="-1" ref="listRef">
            <div v-if="models.length === 0" class="menuItem muted">暂无模型</div>
            <button
              v-for="m in models"
              :key="m.id"
              type="button"
              class="menuItem"
              :class="{ active: m.id === selectedModelId }"
              @click="chooseModel(m.id)"
            >
              <div class="menuMain">{{ m.id }}</div>
              <div class="menuSub">{{ m.owned_by || '' }}</div>
            </button>
          </div>
        </div>
      </header>

      <main class="chat">
        <div v-if="errorText" class="error">{{ errorText }}</div>

        <div v-if="messages.length === 0" class="empty">输入一句话开始聊天</div>

        <div v-for="(m, idx) in messages" :key="idx" class="msg" :class="m.role">
          <div class="stack">
            <div v-if="m.role === 'assistant' && m.think" class="bubble think">
              <div class="thinkTitle">think</div>
              <div class="thinkBody">{{ m.think }}</div>
            </div>
            <div class="bubble">{{ m.content }}</div>
          </div>
        </div>
      </main>

      <footer class="composer">
        <button class="btn ghost" type="button" @click="toggleStream">
          {{ streamMode ? '流式' : '非流式' }}
        </button>

        <input
          v-model="inputText"
          class="input"
          type="text"
          placeholder="输入消息..."
          :disabled="loading"
          @keydown.enter.prevent="send"
        />

        <button class="btn primary" type="button" :disabled="loading" @click="send">
          发送
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.card {
  width: min(900px, 100%);
  height: min(720px, 100vh - 48px);
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #fff;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 12px;
  border-bottom: 1px solid #e5e7eb;
}

.title {
  font-weight: 600;
}

.model {
  position: relative;
}

.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  width: 320px;
  max-height: 320px;
  overflow: auto;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #fff;
  padding: 6px;
}

.menuItem {
  width: 100%;
  text-align: left;
  padding: 10px 10px;
  border: 0;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
}

.menuItem:hover {
  background: #f3f4f6;
}

.menuItem.active {
  background: #e5e7eb;
}

.menuMain {
  font-size: 13px;
  font-weight: 600;
}

.menuSub {
  font-size: 12px;
  opacity: 0.7;
}

.muted {
  opacity: 0.7;
  cursor: default;
}

.chat {
  flex: 1;
  padding: 14px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.empty {
  opacity: 0.7;
  margin: auto;
}

.error {
  color: #b91c1c;
  background: #fef2f2;
  border: 1px solid #fecaca;
  padding: 8px 10px;
  border-radius: 10px;
}

.msg {
  display: flex;
}

.msg.user {
  justify-content: flex-end;
}

.msg.assistant {
  justify-content: flex-start;
}

.bubble {
  max-width: 78%;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
  background: #f9fafb;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}

.msg.user .stack {
  align-items: flex-end;
}

.msg.user .bubble {
  background: #111827;
  color: #fff;
  border-color: #111827;
}

.bubble.think {
  background: #f3f4f6;
  color: #374151;
  border-color: #e5e7eb;
}

.thinkTitle {
  font-size: 12px;
  font-weight: 700;
  opacity: 0.7;
  margin-bottom: 6px;
}

.thinkBody {
  font-size: 13px;
  opacity: 0.9;
}

.composer {
  display: flex;
  gap: 10px;
  padding: 12px;
  border-top: 1px solid #e5e7eb;
}

.input {
  flex: 1;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 10px 12px;
  outline: none;
}

.btn {
  border: 1px solid #e5e7eb;
  background: #fff;
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn.primary {
  background: #111827;
  color: #fff;
  border-color: #111827;
}

.btn.ghost {
  background: #fff;
}
</style>
