/**
 * dsh-drop-in — client half.
 *
 * Global drag & drop interception for the DSH composer. Anything dragged
 * onto the window is classified and handled:
 *
 *   1. local files (mixed types)  → streamed PUT to <workspace>/.dropped/<sessionId>/
 *                                   then a markdown reference is appended to the draft:
 *                                   [附件: name](absolutePath)
 *   2. local images only          → passed through to the native image-attachment
 *                                   pipeline (model sees them natively)
 *   3. folders                    → passed through to the native workspace adoption
 *   4. web image (drag from page) → host-side download (text/uri-list or <img src>),
 *                                   then reference: [网页图片: name](absolutePath)
 *   5. dragged link / URL         → host-side download of the target
 *   6. plain text                 → inserted into the composer; text longer than
 *                                   5000 chars is saved as a .md file instead
 *
 * The composer is only touched through the official slot contract:
 *   conversation.input.left props → { sessionId, inputActions.setDraft, useInput }
 * React is required through the module loader so we share DSH's instance.
 */
window.__ModuleLoader__.load({ id: 'dsh-drop-in', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react')
const { useRef, useEffect } = React

const API = '/dsh-drop-in/v1'
const MAX_INLINE_TEXT = 5000 // chars — beyond this, dragged text becomes a file
const MAX_FILES_PER_DROP = 20
const OVERLAY_HIDE_MS = 180

/* ------------------------------------------------------------------ */
/* styles                                                              */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'dsh-drop-in-style'
const CSS = `
.ddi-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.42);backdrop-filter:blur(1.5px);pointer-events:none}
.ddi-card{display:flex;flex-direction:column;align-items:center;gap:10px;padding:28px 44px;border-radius:16px;background:#fff;color:#0f172a;box-shadow:0 18px 48px rgba(0,0,0,.35);border:2px dashed rgba(15,23,42,.35);max-width:min(420px,86vw);text-align:center}
.ddi-ico{font-size:34px;line-height:1}
.ddi-title{font-size:16px;font-weight:650}
.ddi-sub{font-size:13px;color:rgba(15,23,42,.62);word-break:break-all;max-width:340px}
@media (prefers-color-scheme: dark){
  .ddi-card{background:#1e293b;color:#e2e8f0;border-color:rgba(226,232,240,.4)}
  .ddi-sub{color:rgba(226,232,240,.65)}
}
.ddi-toast-host{position:fixed;right:16px;bottom:16px;z-index:2147483001;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.ddi-toast{max-width:340px;padding:9px 14px;border-radius:9px;background:#0f172a;color:#fff;font-size:13px;line-height:18px;box-shadow:0 8px 24px rgba(0,0,0,.28);opacity:0;transform:translateY(6px);transition:opacity .16s,transform .16s;word-break:break-all}
.ddi-toast.ddi-show{opacity:1;transform:translateY(0)}
.ddi-toast.ddi-err{background:#b91c1c}
`

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.append(style)
}

/* ------------------------------------------------------------------ */
/* overlay + toast (plain DOM singletons)                              */
/* ------------------------------------------------------------------ */

let overlayEl = null
let overlaySub = null

function ensureOverlay() {
  if (overlayEl?.isConnected) return
  overlayEl = document.createElement('div')
  overlayEl.className = 'ddi-overlay'
  overlayEl.hidden = true
  overlayEl.innerHTML = `
    <div class="ddi-card" role="status">
      <div class="ddi-ico">⤵</div>
      <div class="ddi-title">松手，添加到对话</div>
      <div class="ddi-sub"></div>
    </div>`
  overlaySub = overlayEl.querySelector('.ddi-sub')
  document.body.append(overlayEl)
}

function overlayFor(kind) {
  if (kind.kind === 'files') {
    const n = kind.count > 0 ? `${kind.count} 个文件` : '文件'
    return `${n} · 上传到本会话目录并附上路径引用`
  }
  if (kind.kind === 'url') return '网页内容 · 图片/资源将下载后引用，文字将插入输入框'
  if (kind.kind === 'text') return '文字 · 插入输入框（超长文本将存为文件）'
  return ''
}

function showOverlay(kind) {
  ensureOverlay()
  overlaySub.textContent = overlayFor(kind) || ''
  overlayEl.hidden = false
}

function hideOverlay() {
  if (overlayEl) overlayEl.hidden = true
}

const toastListeners = new Set()
let toastItems = []
let toastSeq = 0
let toastHost = null

function ensureToastHost() {
  if (toastHost?.isConnected) return
  toastHost = document.createElement('div')
  toastHost.className = 'ddi-toast-host'
  document.body.append(toastHost)
}

function renderToasts() {
  ensureToastHost()
  toastHost.replaceChildren(...toastItems.map((t) => {
    const el = document.createElement('div')
    el.className = 'ddi-toast ddi-show' + (t.kind === 'err' ? ' ddi-err' : '')
    el.textContent = t.text
    return el
  }))
}

function toast(text, kind = 'ok') {
  const item = { id: ++toastSeq, text, kind }
  toastItems = [...toastItems.slice(-3), item]
  renderToasts()
  setTimeout(() => {
    toastItems = toastItems.filter((t) => t.id !== item.id)
    renderToasts()
  }, 2600)
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function safeGet(dt, type) {
  try { return dt.getData(type) ?? '' } catch { return '' }
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const EXT_BY_MIME = new Map(Object.entries({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif',
}))

function guessNameFromDataUrl(dataUrl) {
  const mime = /^data:([^;,]+)/i.exec(dataUrl)?.[1]?.toLowerCase() ?? ''
  const ext = EXT_BY_MIME.get(mime) ?? 'bin'
  return `inline-image-${stamp()}.${ext}`
}

/* ------------------------------------------------------------------ */
/* drop classification                                                 */
/* ------------------------------------------------------------------ */

/** Coarse classification during dragover — no getData() allowed here. */
function classifyDragOver(dt) {
  const types = dt.types ? Array.from(dt.types) : []
  if (types.includes('Files')) {
    const items = dt.items ? Array.from(dt.items).filter((i) => i.kind === 'file') : []
    for (const it of items) {
      const entry = it.webkitGetAsEntry?.()
      if (entry?.isDirectory) return { kind: 'passthrough' }
    }
    if (items.length > 0 && items.every((it) => String(it.type ?? '').startsWith('image/'))) {
      return { kind: 'passthrough' }
    }
    return { kind: 'files', count: items.length }
  }
  if (types.includes('text/uri-list') || types.includes('text/html')) return { kind: 'url' }
  if (types.includes('text/plain')) return { kind: 'text' }
  return { kind: 'none' }
}

/** Exact classification at drop time — getData() and files are readable. */
function classifyDrop(dt) {
  const files = Array.from(dt.files ?? [])
  if (files.length > 0) {
    const items = Array.from(dt.items ?? [])
    for (const it of items) {
      const entry = it.kind === 'file' ? it.webkitGetAsEntry?.() : null
      if (entry?.isDirectory) return { kind: 'passthrough' }
    }
    if (files.every((f) => String(f.type ?? '').startsWith('image/'))) return { kind: 'passthrough' }
    if (files.length > MAX_FILES_PER_DROP) {
      return { kind: 'too-many', count: files.length }
    }
    return { kind: 'files', files }
  }

  const html = safeGet(dt, 'text/html')
  const plain = safeGet(dt, 'text/plain').trim()
  const uriList = safeGet(dt, 'text/uri-list')
    .split(/\r?\n/).map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))

  const imgSrc = html && /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(html)?.[1]
  if (imgSrc) {
    if (imgSrc.startsWith('data:')) return { kind: 'data-url', url: imgSrc }
    if (/^https?:\/\//i.test(imgSrc)) return { kind: 'url', url: imgSrc }
  }
  // Dragging a link / address: the plain text equals the first uri-list entry.
  const firstUri = uriList[0] ?? ''
  if (firstUri && /^https?:\/\//i.test(firstUri) && (!plain || plain === firstUri)) {
    return { kind: 'url', url: firstUri }
  }
  if (plain) return { kind: 'text', text: safeGet(dt, 'text/plain') }
  if (firstUri && /^https?:\/\//i.test(firstUri)) return { kind: 'url', url: firstUri }
  return { kind: 'none' }
}

/* ------------------------------------------------------------------ */
/* host API                                                            */
/* ------------------------------------------------------------------ */

async function unwrap(res) {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`)
  return data
}

const api = {
  upload(sessionId, name, file) {
    const url = `${API}/upload?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(name)}`
    return fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
      credentials: 'same-origin',
    }).then(unwrap)
  },
  fetchUrl(sessionId, url) {
    return fetch(`${API}/fetch-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, url }),
      credentials: 'same-origin',
    }).then(unwrap)
  },
  saveText(sessionId, name, text) {
    return fetch(`${API}/save-text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, name, text }),
      credentials: 'same-origin',
    }).then(unwrap)
  },
}

/* ------------------------------------------------------------------ */
/* handlers                                                            */
/* ------------------------------------------------------------------ */

function currentDraft(st) {
  return String(st?.draft ?? '')
}

/** Append text to the composer draft through the official inputActions channel. */
function insertIntoComposer(st, text) {
  const cur = currentDraft(st)
  const next = cur.length > 0 ? `${cur.replace(/\s*$/, '')}\n${text}` : text
  st?.inputActions?.setDraft?.(next)
}

async function handleFiles(st, files) {
  const sessionId = st.sessionId
  const refs = []
  let failed = 0
  for (const file of files) {
    try {
      toast(`正在上传 ${file.name} (${fmtSize(file.size)})…`)
      const landed = await api.upload(sessionId, file.name, file)
      refs.push(`[附件: ${landed.name}](${landed.absolutePath})`)
      toast(`已添加 ${landed.name}`)
    } catch (err) {
      failed += 1
      toast(`上传失败 ${file.name}：${err.message}`, 'err')
    }
  }
  if (refs.length > 0) insertIntoComposer(st, refs.join('\n'))
  if (failed > 0 && refs.length === 0) return // nothing landed; keep draft untouched
}

async function handleUrl(st, kind) {
  if (kind.kind === 'data-url') {
    try {
      const blob = await (await fetch(kind.url)).blob()
      const file = new File([blob], guessNameFromDataUrl(kind.url), { type: blob.type })
      await handleFiles(st, [file])
    } catch {
      toast('内联图片解析失败', 'err')
    }
    return
  }
  toast('正在下载网页资源…')
  try {
    const r = await api.fetchUrl(st.sessionId, kind.url)
    const label = String(r.contentType ?? '').startsWith('image/') ? '网页图片' : '网页资源'
    insertIntoComposer(st, `[${label}: ${r.name}](${r.absolutePath})`)
    toast(`已添加 ${r.name} (${fmtSize(r.size)})`)
  } catch (err) {
    toast(`下载失败：${err.message}；已把链接插入输入框`, 'err')
    insertIntoComposer(st, kind.url)
  }
}

async function handleText(st, text) {
  const trimmed = text.length > 200 ? `${text.slice(0, 200)}…` : text
  if (text.length > MAX_INLINE_TEXT) {
    try {
      const r = await api.saveText(st.sessionId, `拖入文字-${stamp()}.md`, text)
      insertIntoComposer(st, `[拖入文字: ${r.name}](${r.absolutePath})`)
      toast(`长文本已存为 ${r.name} (${fmtSize(r.size)})`)
    } catch (err) {
      toast(`保存失败：${err.message}；已把开头片段插入输入框`, 'err')
      insertIntoComposer(st, trimmed)
    }
    return
  }
  insertIntoComposer(st, text)
}

/* ------------------------------------------------------------------ */
/* global drop controller (page-level singleton)                       */
/* ------------------------------------------------------------------ */

let hideTimer = 0

function onDragOver(event) {
  const dt = event.dataTransfer
  if (!dt) return
  const kind = classifyDragOver(dt)
  if (kind.kind === 'none' || kind.kind === 'passthrough') return
  event.preventDefault()
  dt.dropEffect = 'copy'
  showOverlay(kind)
  clearTimeout(hideTimer)
  hideTimer = setTimeout(hideOverlay, OVERLAY_HIDE_MS)
}

async function onDrop(event) {
  clearTimeout(hideTimer)
  hideOverlay()
  const dt = event.dataTransfer
  if (!dt) return
  const kind = classifyDrop(dt)
  if (kind.kind === 'none' || kind.kind === 'passthrough') {
    // Safety net: never let an unhandled file drop navigate the window away.
    if ((dt.types ? Array.from(dt.types) : []).includes('Files') && !event.defaultPrevented) {
      event.preventDefault()
    }
    return
  }
  event.preventDefault()
  if (kind.kind === 'too-many') {
    toast(`一次最多拖入 ${MAX_FILES_PER_DROP} 个文件（本次 ${kind.count} 个）`, 'err')
    return
  }
  const st = controller.ref?.current
  if (!st?.sessionId || typeof st?.inputActions?.setDraft !== 'function') {
    toast('当前会话输入框不可用，未处理拖入内容', 'err')
    return
  }
  try {
    if (kind.kind === 'files') await handleFiles(st, kind.files)
    else if (kind.kind === 'url' || kind.kind === 'data-url') await handleUrl(st, kind)
    else if (kind.kind === 'text') await handleText(st, kind.text)
  } catch (err) {
    toast(`处理拖入内容失败：${err?.message ?? err}`, 'err')
  }
}

const controller = {
  ref: null,
  bound: false,
  attach(ref) {
    controller.ref = ref
    if (!controller.bound) {
      controller.bound = true
      document.addEventListener('dragover', onDragOver, true)
      document.addEventListener('drop', onDrop, true)
    }
  },
  detach(ref) {
    if (controller.ref === ref) controller.ref = null
  },
}

/* ------------------------------------------------------------------ */
/* per-session slot entry                                              */
/* ------------------------------------------------------------------ */

function SessionEntry(props) {
  const sessionId = typeof props?.sessionId === 'string'
    ? props.sessionId
    : String(props?.session?.sessionId ?? '')
  const inputActions = props?.inputActions
  const useInput = props?.useInput

  let draft = ''
  try { draft = useInput ? (useInput((s) => s.draft) ?? '') : '' } catch { draft = '' }

  const stateRef = useRef(null)
  stateRef.current = { sessionId, inputActions, draft }

  useEffect(() => {
    controller.attach(stateRef)
    return () => controller.detach(stateRef)
  }, [])

  return null
}

/* ------------------------------------------------------------------ */
/* entry                                                               */
/* ------------------------------------------------------------------ */

function apply(context) {
  context.effect(() => {
    ensureStyles()
    const disposeSlots = context.slots.inject('conversation.input.left', () =>
      context.slots.register(
        {
          name: 'conversation.input.left',
          id: 'dsh-drop-in.entry',
          order: 11,
          registrant: 'dsh-drop-in',
        },
        SessionEntry,
      ))
    return () => {
      disposeSlots()
    }
  }, 'dsh-drop-in.client')
}

module.exports = { inject: ['slots'], apply }

return module.exports;
} });
