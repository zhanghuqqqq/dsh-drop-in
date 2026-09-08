/**
 * Propagation simulation for the stuck native-overlay fix (v0.1.2).
 * Mirrors ComposerAttachments' document-BUBBLE dragenter/leave/drop listeners
 * (dragDepth counter + reset-on-drop) against the plugin's document-CAPTURE
 * listeners. A takeover-kind drag must leave the native counter untouched.
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.ok(src.includes("addEventListener('dragenter', onDragEnter, true)"), 'plugin binds capture dragenter')

// ---- minimal DOM stub: capture list (plugin) + bubble list (native) ----
const listeners = { capture: [], bubble: [] }
const document = {
  addEventListener(type, fn, opts) { (opts ? listeners.capture : listeners.bubble).push({ type, fn }) },
  removeEventListener() {},
  head: { appendChild() {}, append() {} },
  body: { append() {}, appendChild() {} },
  documentElement: {},
  getElementById: () => null,
  createElement: () => ({ style: {}, appendChild() {}, remove() {}, setAttribute() {}, hidden: false, innerHTML: '', textContent: '', className: '', querySelector: () => ({ textContent: '' }), append() {}, replaceChildren() {}, classList: { add() {}, remove() {}, contains: () => false } }),
  querySelectorAll: () => [],
}
const window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 }
globalThis.document = document
globalThis.window = window

// dispatch: capture pass (stopPropagation blocks everything after, incl. bubble)
function dispatch(type, evt) {
  for (const l of listeners.capture.filter((l) => l.type === type)) {
    evt.stopped = false
    l.fn(evt)
    if (evt.stopped) return 'stopped-in-capture'
  }
  for (const l of listeners.bubble.filter((l) => l.type === type)) l.fn(evt)
  return 'propagated'
}

// load plugin client (ModuleLoader CJS wrapper -> factory(require))
const react = { useRef: (v) => ({ current: v }), useEffect: (fn) => { fn(); return () => {} } }
const fakeRequire = () => react
const body = src.replace('window.__ModuleLoader__.load({ id: \'dsh-drop-in\', factory: (require) => {', '').replace(/return module\.exports;\s*}\s*}\);?\s*$/, '')
const fn = new Function('require', 'window', 'document', body + '\nmodule.exports.__controller = controller\nreturn module.exports')
// Apply registers the slot only; the actual listener binding happens in
// SessionEntry's mount effect (controller.attach). Simulate that mount here:
let effectRan = false
const ctx = {
  slots: {
    inject: () => () => {},
    register: () => 'entry',
  },
  effect: (fn) => { effectRan = true; return fn() },
}
const moduleExports = fn.call(null, fakeRequire, window, document)
moduleExports.apply(ctx)
assert.ok(effectRan, 'apply executed')
const controller = moduleExports.__controller
assert.ok(controller, 'controller exposed')
controller.attach({ current: null }) // equivalent of SessionEntry mount effect
assert.ok(listeners.capture.some((l) => l.type === 'dragenter'), 'capture dragenter bound via attach')
assert.ok(listeners.capture.some((l) => l.type === 'drop'), 'capture drop bound via attach')

// ---- native attachment stub (mirrors ComposerAttachments bubble handlers) ----
let nativeDepth = 0
let nativeActive = false
let nativeDropCalls = 0
for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
  listeners.bubble.push({
    type,
    fn: (evt) => {
      const dt = evt.dataTransfer
      if (!dt || !dt.types.includes('Files')) return
      if (type === 'dragenter') { nativeDepth += 1; nativeActive = true }
      if (type === 'drop') { nativeDropCalls += 1; nativeDepth = 0; nativeActive = false }
      if (type === 'dragleave') { nativeDepth = Math.max(0, nativeDepth - 1); if (nativeDepth === 0) nativeActive = false }
    },
  })
}

const mk = (types, opts = {}) => ({
  dataTransfer: {
    types,
    files: opts.files ?? [],
    items: opts.items ?? [],
    getData: (t) => opts.data?.[t] ?? '',
  },
  preventDefault() { this.pd = true },
  stopPropagation() { this.stopped = true },
})

const results = []
function test(name, cond) { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) process.exitCode = 1 }

// CASE 1: spreadsheet file (takeover kind) — full drag lifecycle, native stays blind
let e = mk(['Files'], {
  files: [{ name: 'table.xlsx', type: '', size: 1024 }],
  items: [{ kind: 'file', type: '' }],
})
dispatch('dragenter', e); dispatch('dragover', e); dispatch('drop', e)
test('CASE1 takeover file: native counter never incremented (overlay never shown, never stuck)', nativeDepth === 0 && !nativeActive && nativeDropCalls === 0)

// CASE 2: pure image (passthrough) — native sees full lifecycle: overlay shows, drop resets it
e = mk(['Files', 'image/png'], {
  files: [{ name: 'a.png', type: 'image/png', size: 2048 }],
  items: [{ kind: 'file', type: 'image/png' }],
})
dispatch('dragenter', e); dispatch('dragover', e); dispatch('drop', e)
test('CASE2 pure image: native lifecycle intact (enter→count 1, drop→reset 0)', nativeDepth === 0 && !nativeActive && nativeDropCalls === 1)

// CASE 3: drag in then out without dropping (takeover) — our dragleave hides overlay, native untouched
e = mk(['Files'], {
  files: [{ name: 'doc.pdf', type: 'application/pdf', size: 512 }],
  items: [{ kind: 'file', type: 'application/pdf' }],
})
dispatch('dragenter', e); dispatch('dragover', e)
const leaveEvt = mk(['Files'], { items: [{ kind: 'file', type: 'application/pdf' }] }); leaveEvt.relatedTarget = null
dispatch('dragleave', leaveEvt)
test('CASE3 takeover cancel-by-leave: native still blind', nativeDepth === 0 && !nativeActive)

// CASE 4: text drag (takeover kind, no Files) — native fileTransfer guard returns early regardless
e = mk(['text/plain'], { data: { 'text/plain': 'some dragged text' } })
dispatch('dragenter', e); dispatch('dragover', e); dispatch('drop', e)
test('CASE4 text drag: no native interaction, no crash', nativeDropCalls === 1) // unchanged from CASE2

// ---- folder scenarios (v0.1.3): folders are takeover, resolved via the Desktop bridge ----
const inserted = []
controller.ref.current = {
  sessionId: 'session-test',
  inputActions: { setDraft: (t) => inserted.push(t) },
  draft: '',
}
const bridgeCalls = []
window.__DSH_DESKTOP_FILE_PATH__ = { getPathForFile: (file) => { bridgeCalls.push(file?.name); return `C:\\Users\\XTX\\${file?.name ?? 'folder'}` } }

// CASE 5: single folder (takeover now) — native stays blind, reference inserted with real path
e = mk(['Files'], {
  files: [{ name: 'MyFolder', type: '', size: 0 }],
  items: [{ kind: 'file', type: '', webkitGetAsEntry: () => ({ isDirectory: true, name: 'MyFolder' }), getAsFile: () => ({ name: 'MyFolder' }) }],
})
dispatch('dragenter', e); dispatch('dragover', e); dispatch('drop', e)
test('CASE5 folder: native never sees it (no images-only toast path)', nativeDropCalls === 1)
test('CASE5 folder: disk-path reference inserted via bridge', inserted.length === 1 && inserted[0].includes('[文件夹: MyFolder](C:\\Users\\XTX\\MyFolder)') && bridgeCalls.includes('MyFolder'))

// CASE 6: folder + file mixed — folder reference AND file upload both fire
let uploads = 0
const origFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  if (String(url).includes('/upload')) { uploads += 1; return { ok: true, json: async () => ({ name: 'doc.pdf', absolutePath: 'X:\\.dropped\\s\\doc.pdf', size: 1 }) } }
  throw new Error('unexpected fetch ' + url)
}
e = mk(['Files'], {
  files: [
    { name: 'MyFolder', type: '', size: 0 },
    { name: 'doc.pdf', type: 'application/pdf', size: 512 },
  ],
  items: [
    { kind: 'file', type: '', webkitGetAsEntry: () => ({ isDirectory: true, name: 'MyFolder' }), getAsFile: () => ({ name: 'MyFolder' }) },
    { kind: 'file', type: 'application/pdf' },
  ],
})
const countBefore = inserted.length
dispatch('dragenter', e); dispatch('dragover', e); dispatch('drop', e)
await new Promise((r) => setTimeout(r, 10))
test('CASE6 mixed: folder ref inserted + file uploaded', inserted.length === countBefore + 2 && inserted[countBefore].includes('[文件夹: MyFolder]') && inserted[countBefore + 1].includes('[附件: doc.pdf]') && uploads === 1)

// CASE 7: bridge missing — folder skipped gracefully with error toast, no crash
delete window.__DSH_DESKTOP_FILE_PATH__
e = mk(['Files'], {
  files: [{ name: 'Orphan', type: '', size: 0 }],
  items: [{ kind: 'file', type: '', webkitGetAsEntry: () => ({ isDirectory: true, name: 'Orphan' }), getAsFile: () => ({ name: 'Orphan' }) }],
})
dispatch('dragenter', e); dispatch('dragover', e); dispatch('drop', e)
test('CASE7 missing bridge: graceful skip, no crash', inserted.length === countBefore + 2) // unchanged (folder skipped)

globalThis.fetch = origFetch
controller.ref.current = null

console.log(results.join('\n'))
