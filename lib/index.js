/**
 * dsh-drop-in — host half.
 *
 * Lands dragged content in the session workspace's `.dropped/<sessionId>/`
 * directory. The filesystem IS the registry: the filename is the single
 * identity, same as dsh-upload-file's convention.
 *
 * Routes (prefix /dsh-drop-in/v1):
 *   PUT  /upload?sessionId&name      application/octet-stream (streamed to disk)
 *   POST /fetch-url {sessionId,url,name?}  host-side streamed download w/ retry
 *   POST /save-text {sessionId,name,text}  persist dragged text as a file
 *
 * Every response carries `absolutePath` — the composer reference the client
 * inserts is a markdown link pointing at that absolute path, so the model can
 * read the file directly with fs tools, no indirection.
 */
import { createWriteStream, readdirSync } from 'node:fs'
import { mkdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Services required before mounting. */
export const inject = ['agents', 'webServer', 'systemPrompt']

const API_PREFIX = '/dsh-drop-in/v1'
const DROP_DIR_NAME = '.dropped'
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024 // 8 GiB
const MAX_FETCH_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB host-side download cap
const MAX_TEXT_BYTES = 10 * 1024 * 1024 // 10 MiB dragged-text file
const FETCH_TIMEOUT_MS = 120_000
const FETCH_RETRIES = 2 // extra attempts after the first failure
/** Session ids arrive as `session-<uuid>` (persisted) or bare `<uuid>`. */
const SESSION_ID_RE = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function sessionDropDir(workspace, sessionId) {
  return join(String(workspace), DROP_DIR_NAME, String(sessionId))
}

/** Sanitize a display name into a safe filesystem basename. */
function safeBasename(name) {
  const base = basename(String(name ?? '').replaceAll('\\', '/')).trim()
  const cleaned = base.replace(/[\u0000-\u001f\u007f/\\:]/g, '_').replace(/^\.+/, '')
  return cleaned.length > 0 ? cleaned : 'file'
}

function readdirSyncSafe(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

/** Resolve a non-colliding filename inside dir: name, name_1, name_2, … */
function uniqueNameIn(dir, desired) {
  if (!readdirSyncSafe(dir).includes(desired)) return desired
  const dot = desired.lastIndexOf('.')
  const base = dot > 0 ? desired.slice(0, dot) : desired
  const ext = dot > 0 ? desired.slice(dot) : ''
  let n = 1
  let next
  do {
    next = `${base}_${n}${ext}`
    n += 1
  } while (readdirSyncSafe(dir).includes(next))
  return next
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function writeError(res, status, code, message) {
  writeJson(res, status, { error: { code, message } })
}

/* ------------------------------------------------------------------ */
/* filename inference for fetched URLs                                 */
/* ------------------------------------------------------------------ */

const EXT_BY_CONTENT_TYPE = new Map(Object.entries({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/markdown': '.md',
  'text/csv': '.csv',
}))

const KNOWN_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.svg', '.ico',
  '.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.ogg', '.flac',
  '.pdf', '.zip', '.7z', '.rar', '.gz', '.tar',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm', '.epub',
  '.exe', '.msi', '.apk', '.dmg', '.iso', '.bin',
])

function dispositionFilename(headers) {
  const cd = headers.get('content-disposition') ?? ''
  const utf8 = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i)
  if (utf8) {
    try { return decodeURIComponent(utf8[1].replaceAll('"', '').trim()) } catch { /* fallthrough */ }
  }
  const plain = cd.match(/filename="?([^";]+)"?/i)
  return plain ? plain[1].trim() : ''
}

/** Pick a filename for a fetched URL: URL basename → disposition → content-type → generic. */
function inferRemoteName(rawUrl, headers, suggested) {
  if (suggested && String(suggested).trim()) return safeBasename(suggested)
  let path = ''
  try {
    path = decodeURIComponent(new URL(rawUrl).pathname)
  } catch { /* malformed — fall through */ }
  const base = safeBasename(path.split('/').pop() ?? '')
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')).toLowerCase() : ''
  if (base && KNOWN_EXTS.has(ext)) return base
  const fromDisposition = safeBasename(dispositionFilename(headers) ?? '')
  if (fromDisposition && fromDisposition !== 'file') return fromDisposition
  const ctype = (headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const mapped = EXT_BY_CONTENT_TYPE.get(ctype)
  if (base) return mapped && ext !== mapped ? `${base}${mapped}` : (base || 'download')
  if (mapped) return `download${mapped}`
  return 'download'
}

/* ------------------------------------------------------------------ */
/* host-side streamed download with retry                              */
/* ------------------------------------------------------------------ */

class DownloadCapError extends Error {
  constructor() {
    super(`下载内容超过 ${Math.floor(MAX_FETCH_BYTES / 1024 / 1024)}MB 上限`)
    this.name = 'DownloadCapError'
  }
}

/** Stream one URL to disk. Returns {path, bytes, contentType, finalUrl}. */
async function downloadTo(dir, rawUrl, suggested) {
  let url = String(rawUrl ?? '').trim()
  let parsed
  try { parsed = new URL(url) } catch { throw new Error('URL 无法解析') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 链接')
  }

  let lastError = null
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 800 * attempt))
    }
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-drop-in/0.1',
          accept: '*/*',
        },
      })
      if (!res.ok) {
        if (res.status >= 500 || res.status === 429) {
          lastError = new Error(`远端返回 HTTP ${res.status}`)
          continue
        }
        throw new Error(`远端返回 HTTP ${res.status}`)
      }
      const finalUrl = res.url || url
      const name = uniqueNameIn(dir, inferRemoteName(finalUrl, res.headers, suggested))
      const target = join(dir, name)
      const sink = createWriteStream(target)
      let bytes = 0
      try {
        const source = Readable.fromWeb(res.body).on('data', (chunk) => {
          bytes += chunk.length
          if (bytes > MAX_FETCH_BYTES) sink.destroy(new DownloadCapError())
        })
        await pipeline(source, sink)
      } catch (err) {
        await rm(target, { force: true }).catch(() => {})
        throw err
      }
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim()
      return { name, absolutePath: target, size: bytes, contentType, finalUrl }
    } catch (err) {
      lastError = err
      if (err instanceof DownloadCapError) throw err
      if (err?.name === 'AbortError') lastError = new Error('下载超时')
      const msg = lastError?.message ?? ''
      // Permanent failures: malformed input and 4xx other than 429 (rate limit).
      if (msg.startsWith('仅支持') || msg.startsWith('URL 无法解析')) throw lastError
      if (/^远端返回 HTTP 4\d\d$/.test(msg) && msg !== '远端返回 HTTP 429') throw lastError
      // 5xx / 429 / network errors are retryable — loop.
    }
  }
  throw lastError ?? new Error('下载失败')
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

export function apply(context) {
  /** Resolve the session workspace root, or null when the session is unknown. */
  const resolveWorkspace = (sessionId) => {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null
    try {
      const agent = context.agents.get(sessionId)
      return agent?.session?.header?.cwd ?? null
    } catch {
      return null
    }
  }

  const requireSession = (sessionId) => {
    const workspace = resolveWorkspace(sessionId)
    if (!workspace) throw Object.assign(new Error('Session workspace not found.'), { status: 404, code: 'DROP_SESSION_NOT_FOUND' })
    return workspace
  }

  /** Land one readable web stream into the session dir. */
  const landStream = async (sessionId, desiredName, source, maxBytes) => {
    const workspace = requireSession(sessionId)
    const dir = sessionDropDir(workspace, sessionId)
    await mkdir(dir, { recursive: true })
    const name = uniqueNameIn(dir, safeBasename(desiredName))
    const target = join(dir, name)
    const sink = createWriteStream(target)
    let bytes = 0
    try {
      source.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > maxBytes) sink.destroy(new Error('payload too large'))
      })
      await pipeline(source, sink)
    } catch (err) {
      await rm(target, { force: true }).catch(() => {})
      throw err
    }
    return { name, absolutePath: target, size: bytes }
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    /* ---- PUT /upload?sessionId&name — streamed local-file landing ---- */
    if (req.method === 'PUT' && path === `${API_PREFIX}/upload`) {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const name = url.searchParams.get('name') ?? ''
      if (!sessionId || !name) {
        return writeError(res, 400, 'DROP_BAD_REQUEST', 'sessionId and name are required.')
      }
      try {
        const landed = await landStream(sessionId, name, req, MAX_UPLOAD_BYTES)
        return writeJson(res, 200, landed)
      } catch (err) {
        if (err?.status) return writeError(res, err.status, err.code ?? 'DROP_UPLOAD_FAILED', err.message)
        return writeError(res, err.message === 'payload too large' ? 413 : 400, 'DROP_UPLOAD_FAILED', err.message)
      }
    }

    /* ---- POST /fetch-url — host-side streamed download ---- */
    if (req.method === 'POST' && path === `${API_PREFIX}/fetch-url`) {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return writeError(res, 400, 'DROP_BAD_REQUEST', 'Invalid JSON body.')
      }
      const { sessionId, url: rawUrl, name } = body ?? {}
      if (typeof sessionId !== 'string' || typeof rawUrl !== 'string') {
        return writeError(res, 400, 'DROP_BAD_REQUEST', 'sessionId and url are required.')
      }
      try { requireSession(sessionId) } catch (err) {
        return writeError(res, 404, 'DROP_SESSION_NOT_FOUND', 'Session workspace not found.')
      }
      const dir = sessionDropDir(requireSession(sessionId), sessionId)
      await mkdir(dir, { recursive: true })
      try {
        const result = await downloadTo(dir, rawUrl, typeof name === 'string' ? name : '')
        return writeJson(res, 200, result)
      } catch (err) {
        return writeError(res, 502, 'DROP_FETCH_FAILED', err?.message ?? '下载失败')
      }
    }

    /* ---- POST /save-text — persist dragged text as a file ---- */
    if (req.method === 'POST' && path === `${API_PREFIX}/save-text`) {
      let body
      try {
        body = JSON.parse(await readBody(req, 16 * 1024 * 1024))
      } catch {
        return writeError(res, 400, 'DROP_BAD_REQUEST', 'Invalid JSON body.')
      }
      const { sessionId, name, text } = body ?? {}
      if (typeof sessionId !== 'string' || typeof text !== 'string' || typeof name !== 'string') {
        return writeError(res, 400, 'DROP_BAD_REQUEST', 'sessionId, name and text are required.')
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
        return writeError(res, 413, 'DROP_TEXT_TOO_LARGE', 'Text exceeds 10MiB.')
      }
      try {
        const workspace = requireSession(sessionId)
        const dir = sessionDropDir(workspace, sessionId)
        await mkdir(dir, { recursive: true })
        const fileName = uniqueNameIn(dir, safeBasename(name))
        const target = join(dir, fileName)
        await writeFile(target, text, 'utf8')
        const info = await stat(target)
        return writeJson(res, 200, { name: fileName, absolutePath: target, size: info.size })
      } catch (err) {
        return writeError(res, 500, 'DROP_SAVE_FAILED', err.message)
      }
    }

    /* ---- DELETE /file?sessionId&name — remove one dropped file ---- */
    if (req.method === 'DELETE' && path === `${API_PREFIX}/file`) {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const name = url.searchParams.get('name') ?? ''
      if (!sessionId || !name) {
        return writeError(res, 400, 'DROP_BAD_REQUEST', 'sessionId and name are required.')
      }
      try {
        const dir = normalize(sessionDropDir(requireSession(sessionId), sessionId))
        const target = normalize(join(dir, safeBasename(name)))
        if (target !== dir && !target.startsWith(dir + sep)) {
          return writeError(res, 400, 'DROP_BAD_REQUEST', 'Path escapes the session drop directory.')
        }
        await unlink(target).catch((e) => {
          if (e?.code !== 'ENOENT') throw e
        })
        return writeJson(res, 200, { ok: true })
      } catch (err) {
        return writeError(res, err.status ?? 500, err.code ?? 'DROP_DELETE_FAILED', err.message)
      }
    }

    return writeError(res, 404, 'DROP_NOT_FOUND', 'Route not found.')
  }

  context.effect(function* registerDropInHost() {
    yield context.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler,
    })
  }, 'dsh-drop-in.host')

  // Inject the drop-file convention into the system prompt so the model
  // immediately understands the markdown links the client inserts.
  context.inject(['systemPrompt'], (scope) => scope.systemPrompt.context({
    name: 'dsh-drop-in:dropped-files',
    order: 111,
    text: (assemblyContext) => {
      try {
        const agent = assemblyContext?.agent
        const header = agent?.session?.header
        const cwd = header?.cwd
        const sessionId = header?.id
        if (!cwd || !sessionId || !SESSION_ID_RE.test(String(sessionId))) return ''
        const sessionDir = join(String(cwd), DROP_DIR_NAME, String(sessionId))
        const names = readdirSyncSafe(sessionDir)
        if (!names.some((n) => !n.startsWith('.'))) return ''
        return `本会话的拖放文件存放在 ${sessionDir}/ 目录；用户消息中形如「[附件: 文件名](绝对路径)」或「[网页资源: 文件名](绝对路径)」的 markdown 链接是拖进对话框的内容，括号内即文件在磁盘上的绝对路径，直接用该路径读取文件本身。`
      } catch {
        return ''
      }
    },
  }), 'dsh-drop-in.system-prompt')
}
