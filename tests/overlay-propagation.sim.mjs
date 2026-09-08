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

console.log(results.join('\n'))
