/**
 * dsh-drop-in host smoke test — runs lib/index.js against a mock context.
 * No network beyond a local http server; no DSH runtime required.
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const SESSION = 'session-5c685519-838b-4062-86f4-998dfd1c5045'
let workspace = ''
let registeredHandler = null
let systemPromptSpec = null

const context = {
  agents: {
    get(id) {
      if (id === SESSION) return { session: { header: { cwd: workspace, id } } }
      return undefined
    },
  },
  webServer: {
    register(def) {
      assert.equal(def.kind, 'prefix')
      assert.equal(def.path, '/dsh-drop-in/v1')
      registeredHandler = def.handler
      return 'registered'
    },
  },
  effect(fn) {
    const gen = fn()
    gen.next() // runs until `yield context.webServer.register(...)`
  },
  inject(_deps, fn) {
    fn({
      systemPrompt: {
        context: (spec) => {
          systemPromptSpec = spec
        },
      },
    })
  },
}

/* --- minimal req/res mocks ----------------------------------------- */

function mockReq(method, url, body, headers = {}) {
  const req = new PassThrough()
  req.method = method
  req.url = url
  req.headers = { ...headers }
  req.end(body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : undefined)
  return req
}

function mockRes() {
  const res = {
    statusCode: 0,
    headers: null,
    chunks: [],
    ended: false,
    writeHead(status, headers) { res.statusCode = status; res.headers = headers },
    end(chunk) { if (chunk) res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); res.ended = true },
    write(chunk) { res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true },
    destroy() { res.ended = true },
  }
  res.json = async () => JSON.parse(Buffer.concat(res.chunks).toString('utf8'))
  res.body = () => Buffer.concat(res.chunks)
  return res
}

async function call(method, url, body) {
  const req = mockReq(method, url, body)
  const res = mockRes()
  await registeredHandler(req, res)
  return res
}

/* --- local origin server for fetch-url tests ------------------------ */

const origin = createServer((req, res) => {
  if (req.url === '/pixel.png') {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]))
    return
  }
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/pixel.png' })
    res.end()
    return
  }
  if (req.url === '/forbidden') {
    res.writeHead(403)
    res.end()
    return
  }
  if (req.url === '/named') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report Q3.pdf"' })
    res.end(Buffer.from('%PDF-fake'))
    return
  }
  res.writeHead(404)
  res.end()
})

/* --- tests ----------------------------------------------------------- */

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push(`PASS  ${name}`)
  } catch (err) {
    results.push(`FAIL  ${name}: ${err.message}`)
    process.exitCode = 1
  }
}

async function main() {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-drop-in-'))
  await new Promise((r) => origin.listen(0, '127.0.0.1', r))
  const port = origin.address().port
  apply(context)
  assert.ok(registeredHandler, 'handler registered')

  const dir = join(workspace, '.dropped', SESSION)

  await test('PUT /upload lands a file and returns absolute path', async () => {
    const res = await call('PUT', `/dsh-drop-in/v1/upload?sessionId=${SESSION}&name=hello.txt`, '你好，拖拽！')
    assert.equal(res.statusCode, 200)
    const data = await res.json()
    assert.equal(data.name, 'hello.txt')
    assert.equal(await readFile(data.absolutePath, 'utf8'), '你好，拖拽！')
  })

  await test('PUT /upload dedupes with _1 suffix', async () => {
    const res = await call('PUT', `/dsh-drop-in/v1/upload?sessionId=${SESSION}&name=hello.txt`, 'second')
    const data = await res.json()
    assert.equal(data.name, 'hello_1.txt')
  })

  await test('PUT /upload rejects unknown session', async () => {
    const res = await call('PUT', '/dsh-drop-in/v1/upload?sessionId=session-00000000-0000-0000-0000-000000000000&name=x.txt', 'x')
    assert.equal(res.statusCode, 404)
  })

  await test('PUT /upload sanitizes path traversal in name', async () => {
    const res = await call('PUT', `/dsh-drop-in/v1/upload?sessionId=${SESSION}&name=..%2F..%2Fescape.txt`, 'evil')
    const data = await res.json()
    assert.ok(data.absolutePath.startsWith(dir), `landed inside drop dir: ${data.absolutePath}`)
  })

  await test('POST /save-text writes dragged text', async () => {
    const res = await call('POST', '/dsh-drop-in/v1/save-text', JSON.stringify({ sessionId: SESSION, name: `拖入文字-${'120000'}.md`, text: '# 大段文字\n'.repeat(10) }))
    assert.equal(res.statusCode, 200)
    const data = await res.json()
    assert.ok(data.absolutePath.endsWith('.md'))
    assert.ok((await readFile(data.absolutePath, 'utf8')).includes('大段文字'))
  })

  await test('POST /fetch-url downloads and infers extension from content-type', async () => {
    const res = await call('POST', '/dsh-drop-in/v1/fetch-url', JSON.stringify({ sessionId: SESSION, url: `http://127.0.0.1:${port}/pixel.png` }))
    assert.equal(res.statusCode, 200)
    const data = await res.json()
    assert.equal(data.name, 'pixel.png')
    assert.equal(data.contentType, 'image/png')
    const bytes = await readFile(data.absolutePath)
    assert.equal(bytes[0], 0x89)
  })

  await test('POST /fetch-url follows redirects', async () => {
    const res = await call('POST', '/dsh-drop-in/v1/fetch-url', JSON.stringify({ sessionId: SESSION, url: `http://127.0.0.1:${port}/redirect` }))
    const data = await res.json()
    assert.equal(data.name, 'pixel_1.png')
  })

  await test('POST /fetch-url honors content-disposition filename', async () => {
    const res = await call('POST', '/dsh-drop-in/v1/fetch-url', JSON.stringify({ sessionId: SESSION, url: `http://127.0.0.1:${port}/named` }))
    const data = await res.json()
    assert.equal(data.name, 'report Q3.pdf')
  })

  await test('POST /fetch-url surfaces 4xx as 502', async () => {
    const res = await call('POST', '/dsh-drop-in/v1/fetch-url', JSON.stringify({ sessionId: SESSION, url: `http://127.0.0.1:${port}/forbidden` }))
    assert.equal(res.statusCode, 502)
  })

  await test('POST /fetch-url rejects non-http protocols', async () => {
    const res = await call('POST', '/dsh-drop-in/v1/fetch-url', JSON.stringify({ sessionId: SESSION, url: 'file:///C:/Windows/win.ini' }))
    assert.equal(res.statusCode, 502)
    const data = await res.json()
    assert.match(data.error.message, /http\/https/)
  })

  await test('DELETE /file stays inside the drop dir', async () => {
    const res = await call('DELETE', `/dsh-drop-in/v1/file?sessionId=${SESSION}&name=hello.txt`)
    assert.equal(res.statusCode, 200)
    const names = (await readdir(dir)).filter((n) => !n.startsWith('.'))
    assert.ok(!names.includes('hello.txt'))
  })

  await test('system prompt injection appears once files exist', async () => {
    assert.ok(systemPromptSpec, 'system prompt context registered')
    const text = systemPromptSpec.text({ agent: { session: { header: { cwd: workspace, id: SESSION } } } })
    assert.ok(text.includes('.dropped'), 'mentions the drop dir')
    assert.ok(text.includes('markdown'), 'explains the reference convention')
  })

  origin.close()
  await rm(workspace, { recursive: true, force: true })
  console.log(results.join('\n'))
}

main().catch((err) => {
  console.error('smoke test crashed:', err)
  process.exit(1)
})
