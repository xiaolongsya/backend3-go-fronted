<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import {
  createChatCompletionNonStream,
  createChatCompletionStream,
  deleteFile,
  fetchFileMeta,
  fetchAllModels,
  fetchFiles,
  fetchModels,
  type ChatMessage,
  type FileObject,
  type ModelItem,
  uploadFile,
  updateModelEnabled,
} from './api'

type UiMessage = {
  role: 'user' | 'assistant'
  content: string
  think?: string
}

const models = ref<ModelItem[]>([])
const allModels = ref<ModelItem[]>([])
const modelMenuOpen = ref(false)
const selectedModelId = ref<string>('')

const streamMode = ref(true)
const inputText = ref('')
const inputRef = ref<HTMLTextAreaElement | null>(null)

const messages = ref<UiMessage[]>([])
const loading = ref(false)
const errorText = ref<string>('')

const chatRef = ref<HTMLDivElement | null>(null)
const autoScroll = ref(true)
let scrollRafId: number | null = null

const listRef = ref<HTMLDivElement | null>(null)
const abortController = ref<AbortController | null>(null)

const allModelsLoading = ref(false)
const modelToggling = ref<Set<string>>(new Set())

const files = ref<FileObject[]>([])
const filesLoading = ref(false)
const uploading = ref(false)
const deleting = ref<Set<string>>(new Set())
const purposeText = ref('assistants')
const selectedUploadFile = ref<File | null>(null)
const selectedFileMeta = ref<FileObject | null>(null)
const filePanelOpen = ref(true)
const mobilePanel = ref<'chat' | 'models' | 'files'>('chat')

function showMobilePanel(panel: 'chat' | 'models' | 'files') {
  mobilePanel.value = panel
}

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

function onChatScroll() {
  const el = chatRef.value
  if (!el) return
  const distanceToBottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
  autoScroll.value = distanceToBottom < 40
}

function scrollToBottom() {
  if (!autoScroll.value) return
  if (scrollRafId != null) return
  scrollRafId = window.requestAnimationFrame(() => {
    scrollRafId = null
    nextTick(() => {
      const el = chatRef.value
      if (!el) return
      el.scrollTop = el.scrollHeight
    })
  })
}

const selectedModelLabel = computed(() => selectedModelId.value || '选择模型')

async function loadModels() {
  errorText.value = ''
  const resp = await fetchModels()
  models.value = resp.data || []

  // Keep selection valid
  if (!selectedModelId.value) {
    if (models.value.length > 0) selectedModelId.value = models.value[0].id
    return
  }
  if (!models.value.some((m) => m.id === selectedModelId.value)) {
    selectedModelId.value = models.value.length > 0 ? models.value[0].id : ''
  }
}

async function loadAllModels() {
  allModelsLoading.value = true
  try {
    const resp = await fetchAllModels()
    allModels.value = resp.data || []
  } finally {
    allModelsLoading.value = false
  }
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(1)} MB`
}

function formatUnix(ts: number) {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const d = new Date(ts * 1000)
  return d.toLocaleString()
}

async function loadFiles() {
  filesLoading.value = true
  try {
    const resp = await fetchFiles()
    files.value = resp.data || []
  } finally {
    filesLoading.value = false
  }
}

function onFilePick(e: Event) {
  const input = e.target as HTMLInputElement
  selectedUploadFile.value = input.files && input.files[0] ? input.files[0] : null
}

async function doUpload() {
  if (!selectedUploadFile.value) {
    errorText.value = '请先选择文件'
    return
  }
  if (uploading.value) return

  uploading.value = true
  try {
    errorText.value = ''
    await uploadFile(selectedUploadFile.value, purposeText.value.trim())
    selectedUploadFile.value = null
    selectedFileMeta.value = null
    await loadFiles()
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : String(e)
  } finally {
    uploading.value = false
  }
}

async function showMeta(fileId: string) {
  try {
    errorText.value = ''
    selectedFileMeta.value = await fetchFileMeta(fileId)
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : String(e)
  }
}

async function removeFile(fileId: string) {
  if (deleting.value.has(fileId)) return
  deleting.value.add(fileId)
  try {
    errorText.value = ''
    await deleteFile(fileId)
    if (selectedFileMeta.value?.id === fileId) selectedFileMeta.value = null
    await loadFiles()
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : String(e)
  } finally {
    deleting.value.delete(fileId)
  }
}

async function toggleModel(modelId: string, enabled: boolean) {
  if (modelToggling.value.has(modelId)) return
  modelToggling.value.add(modelId)
  try {
    errorText.value = ''
    await updateModelEnabled(modelId, enabled)
    // refresh both lists
    await Promise.all([loadAllModels(), loadModels()])
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : String(e)
  } finally {
    modelToggling.value.delete(modelId)
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

function autosizeTextarea() {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  const maxPx = 120
  el.style.height = Math.min(el.scrollHeight, maxPx) + 'px'
}

function onComposerKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter') return
  // Enter: newline (default)
  // Ctrl/Cmd+Enter: send
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    send()
  }
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
  autosizeTextarea()

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

      const msg = messages.value[assistantIndex]
      if (pendingThink) {
        msg.think = (msg.think || '') + pendingThink
        pendingThink = ''
      }
      if (pendingVisible) {
        msg.content = msg.content + pendingVisible
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

onMounted(() => {
  Promise.all([loadModels(), loadAllModels(), loadFiles()]).catch((e) => {
    errorText.value = e instanceof Error ? e.message : String(e)
  })
  nextTick(() => autosizeTextarea())
})
</script>

<template>
  <div class="page">
    <div class="layout">
      <div class="mobileTabs">
        <button class="mobileTab" type="button" :class="{ active: mobilePanel === 'chat' }" @click="showMobilePanel('chat')">
          对话
        </button>
        <button class="mobileTab" type="button" :class="{ active: mobilePanel === 'models' }" @click="showMobilePanel('models')">
          模型
        </button>
        <button class="mobileTab" type="button" :class="{ active: mobilePanel === 'files' }" @click="showMobilePanel('files')">
          文件
        </button>
      </div>

      <aside class="sidebar pane pane-models" :class="{ active: mobilePanel === 'models' }">
        <div class="sideHeader">
          <div class="sideTitle">模型管理</div>
        </div>

        <div class="sideBody">
          <div v-if="allModelsLoading" class="sideHint">加载中...</div>
          <div v-else-if="allModels.length === 0" class="sideHint">暂无模型</div>

          <div v-else class="modelList">
            <div v-for="m in allModels" :key="m.id" class="modelRow">
              <div class="modelName">{{ m.id }}</div>
              <div class="modelOps">
                <span class="dot" :class="m.enabled ? 'on' : 'off'" aria-hidden="true" />

                <button
                  class="btn tiny"
                  type="button"
                  :disabled="m.enabled || modelToggling.has(m.id)"
                  @click="toggleModel(m.id, true)"
                >
                  启用
                </button>
                <button
                  class="btn tiny"
                  type="button"
                  :disabled="!m.enabled || modelToggling.has(m.id)"
                  @click="toggleModel(m.id, false)"
                >
                  禁用
                </button>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <div class="card pane pane-chat" :class="{ active: mobilePanel === 'chat' }">
      <header class="header">
        <div class="title">AI Chat</div>

        <div class="model">
          <div class="modelLabel">可用模型</div>
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

      <main class="chat" ref="chatRef" @scroll.passive="onChatScroll">
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

        <textarea
          v-model="inputText"
          ref="inputRef"
          class="input"
          rows="1"
          placeholder="输入消息...（回车换行，Ctrl/⌘+Enter 发送）"
          :disabled="loading"
          @keydown="onComposerKeydown"
          @input="autosizeTextarea"
        />

        <button class="btn primary" type="button" :disabled="loading" @click="send">
          发送
        </button>
      </footer>
      </div>

      <aside class="sidebar filesSidebar pane pane-files" :class="{ active: mobilePanel === 'files' }">
        <div class="sideHeader filesHeader">
          <div class="sideTitle">文件管理</div>
          <button class="btn tiny" type="button" @click="filePanelOpen = !filePanelOpen">
            {{ filePanelOpen ? '收起' : '展开' }}
          </button>
        </div>

        <div v-if="filePanelOpen" class="sideBody">
          <div class="uploadBox">
            <div class="row">
              <label class="label">purpose</label>
              <input v-model="purposeText" class="textInput" type="text" placeholder="assistants" />
            </div>
            <div class="row">
              <label class="label">file</label>
              <input class="fileInput" type="file" @change="onFilePick" />
            </div>
            <div class="row ops">
              <button class="btn primary" type="button" :disabled="uploading" @click="doUpload">
                {{ uploading ? '上传中...' : '上传' }}
              </button>
              <button class="btn" type="button" :disabled="filesLoading" @click="loadFiles">
                刷新
              </button>
            </div>
            <div v-if="selectedUploadFile" class="hint">
              已选择：{{ selectedUploadFile.name }}（{{ formatBytes(selectedUploadFile.size) }}）
            </div>
          </div>

          <div class="filesList">
            <div v-if="filesLoading" class="sideHint">加载中...</div>
            <div v-else-if="files.length === 0" class="sideHint">暂无文件</div>

            <div v-else class="fileRows">
              <div v-for="f in files" :key="f.id" class="fileRow">
                <div class="fileMain">
                  <div class="fileName" :title="f.filename">{{ f.filename }}</div>
                  <div class="fileSub">
                    <span class="mono">{{ formatBytes(f.bytes) }}</span>
                    <span class="sep">·</span>
                    <span class="mono">{{ f.purpose || '-' }}</span>
                  </div>
                  <div class="fileId mono" :title="f.id">{{ f.id }}</div>
                </div>

                <div class="fileOps">
                  <button class="btn tiny" type="button" @click="showMeta(f.id)">详情</button>
                  <button
                    class="btn tiny"
                    type="button"
                    :disabled="deleting.has(f.id)"
                    @click="removeFile(f.id)"
                  >
                    {{ deleting.has(f.id) ? '删除中' : '删除' }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div v-if="selectedFileMeta" class="metaBox">
            <div class="metaTitle">元信息</div>
            <div class="metaBody">
              <div><span class="k">id</span> <span class="mono">{{ selectedFileMeta.id }}</span></div>
              <div><span class="k">filename</span> {{ selectedFileMeta.filename }}</div>
              <div><span class="k">bytes</span> <span class="mono">{{ formatBytes(selectedFileMeta.bytes) }}</span></div>
              <div><span class="k">purpose</span> <span class="mono">{{ selectedFileMeta.purpose || '-' }}</span></div>
              <div><span class="k">created_at</span> <span class="mono">{{ formatUnix(selectedFileMeta.created_at) }}</span></div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: flex;
  align-items: stretch;
  justify-content: center;
  padding: 24px;
}

.layout {
  width: min(1200px, 100%);
  display: flex;
  gap: 12px;
  min-height: 0;
}

.mobileTabs {
  display: none;
}

.pane {
  min-height: 0;
}

.sidebar {
  width: 300px;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #fff;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.filesSidebar {
  width: 300px;
}

.sideHeader {
  padding: 12px;
  border-bottom: 1px solid #e5e7eb;
}

.filesHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.sideTitle {
  font-weight: 600;
}

.sideBody {
  padding: 12px;
  overflow: auto;
}

.sideHint {
  opacity: 0.7;
  font-size: 13px;
}

.modelList {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.modelRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 10px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
}

.modelName {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modelOps {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  display: inline-block;
}

.dot.on {
  background: #16a34a;
}

.dot.off {
  background: #b91c1c;
}

.card {
  flex: 1;
  height: min(720px, 100vh - 48px);
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #fff;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.uploadBox {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.uploadBox .row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.uploadBox .row.ops {
  justify-content: flex-end;
}

.label {
  width: 64px;
  font-size: 12px;
  opacity: 0.75;
}

.textInput {
  flex: 1;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 13px;
}

.fileInput {
  flex: 1;
  font-size: 13px;
}

.hint {
  font-size: 12px;
  opacity: 0.75;
}

.filesList {
  margin-top: 12px;
}

.fileRows {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.fileRow {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 10px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.fileMain {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.fileName {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fileSub {
  font-size: 12px;
  opacity: 0.75;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.sep {
  opacity: 0.6;
}

.fileId {
  font-size: 12px;
  opacity: 0.75;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.fileOps {
  flex-shrink: 0;
  display: flex;
  gap: 8px;
}

.metaBox {
  margin-top: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 10px;
}

.metaTitle {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
}

.metaBody {
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.metaBody .k {
  display: inline-block;
  width: 86px;
  opacity: 0.75;
}

.mono {
  font-family: ui-monospace, Consolas, monospace;
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
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.modelLabel {
  font-size: 12px;
  opacity: 0.75;
  white-space: nowrap;
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
  z-index: 10;
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
  min-height: 0;
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
  resize: none;
  line-height: 1.35;
  min-height: 40px;
}

.btn {
  border: 1px solid #e5e7eb;
  background: #fff;
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
}

.btn.tiny {
  padding: 6px 10px;
  border-radius: 10px;
  font-size: 12px;
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

/* Mobile adaptation */
@media (max-width: 900px) {
  .page {
    padding: 0;
    align-items: stretch;
    height: 100svh;
    overflow: hidden;
  }

  .layout {
    width: 100%;
    height: 100%;
    padding: 8px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    overflow: hidden;
  }

  .mobileTabs {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    flex: 0 0 auto;
  }

  .mobileTab {
    border: 1px solid #e5e7eb;
    background: #fff;
    border-radius: 12px;
    padding: 10px 12px;
    font-size: 14px;
    font-weight: 600;
  }

  .mobileTab.active {
    background: #111827;
    color: #fff;
    border-color: #111827;
  }

  .pane {
    display: none;
  }

  .pane.active {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
  }

  .card {
    width: 100%;
    height: 100%;
    border-radius: 12px;
    min-height: 0;
  }

  .sidebar {
    width: 100%;
    height: 100%;
    max-height: none;
    border-radius: 12px;
    min-height: 0;
    overflow: hidden;
  }

  .sidebar .sideHeader {
    flex: 0 0 auto;
  }

  .sideBody {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  .header {
    padding: 10px 10px;
    gap: 8px;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .chat {
    padding: 12px;
    flex: 1 1 auto;
  }

  .bubble {
    max-width: 90%;
  }

  .model {
    position: static;
  }

  .menu {
    position: fixed;
    left: 12px;
    right: 12px;
    top: 58px;
    width: auto;
    max-height: 55vh;
    z-index: 50;
  }

  .composer {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: end;
    gap: 8px;
    padding: 10px;
    background: #fff;
  }

  .btn {
    padding: 10px 10px;
  }

  .input {
    padding: 10px 10px;
  }

  .uploadBox .row {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
  }

  .label {
    width: auto;
  }

  .fileRow {
    flex-direction: column;
    align-items: stretch;
  }

  .fileOps {
    justify-content: flex-end;
  }
}

@media (max-width: 480px) {
  .composer {
    grid-template-columns: 1fr auto;
  }

  .composer .btn.ghost {
    grid-column: 1 / -1;
  }

  .title {
    font-size: 15px;
  }

  .model {
    width: 100%;
    justify-content: space-between;
  }
}
</style>
