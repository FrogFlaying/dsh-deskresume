/**
 * DeskResume — tests for how the settings page reports a partial restore.
 *
 * A restore is never all-or-nothing: some apps launch, some folders reopen, some
 * windows fail to match. The server answers 500 when *any* item failed, and the
 * page used to treat that status as a total failure — it threw the report away
 * and rendered the message under the "could not load snapshots" heading.
 *
 * That is exactly the symptom a user reported: the desktop visibly came back,
 * yet the plugin showed an error that had nothing to do with snapshots.
 *
 * These tests drive the real client.js through the same minimal React harness the
 * i18n tests use, so they assert on what actually renders.
 *
 * Run: node --test test/client-restore-report.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const clientPath = `file:///${path.join(rootDir, 'client.js').replace(/\\/g, '/')}`

function makeReact() {
  const runtime = { values: [], index: 0, effects: [] }

  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.filter(c => c !== undefined && c !== null && c !== false),
  })

  const React = {
    createElement,
    useState(initial) {
      const i = runtime.index++
      if (!(i in runtime.values)) runtime.values[i] = initial
      return [runtime.values[i], next => {
        runtime.values[i] = typeof next === 'function' ? next(runtime.values[i]) : next
      }]
    },
    useCallback(fn) { runtime.index++; return fn },
    useEffect(fn) { runtime.index++; runtime.effects.push(fn) },
    useMemo(fn) { runtime.index++; return fn() },
  }

  function expand(node) {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(expand)
    if (typeof node.type === 'function') {
      runtime.index = 0
      return expand(node.type(node.props))
    }
    return { ...node, children: (node.children ?? []).map(expand) }
  }

  /**
   * Render the component, optionally flushing its mount effects.
   *
   * `runEffects` must be false on re-renders: the page's `useEffect(..., [])`
   * loads the snapshot list once, and that load starts with `setError(null)`.
   * Re-running it on every render — which a naive harness does — would erase the
   * very error a test is trying to observe. Real React runs it once, so the
   * harness has to as well, or the tests measure the harness instead of the page.
   */
  async function mount(Component, props, { runEffects = true } = {}) {
    runtime.index = 0
    if (runEffects) runtime.effects = []
    expand(Component(props))

    if (runEffects) {
      const queued = runtime.effects
      runtime.effects = []
      for (const fn of queued) fn()

      await new Promise(r => setTimeout(r, 0))
      await new Promise(r => setTimeout(r, 0))

      runtime.index = 0
      return expand(Component(props))
    }

    // Let any promise chain started by a click settle, then render once.
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    runtime.index = 0
    return expand(Component(props))
  }

  return { React, mount }
}

async function loadClient() {
  let captured = null
  globalThis.window = {
    __ModuleLoader__: { load: spec => { captured = spec } },
    confirm: () => true,
  }
  await import(`${clientPath}?v=${Math.random()}`)
  assert.ok(captured, 'client.js should register itself with the ModuleLoader')

  const { React, mount } = makeReact()
  const mod = captured.factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected require("${name}")`)
  })
  return { mod, mount }
}

function stringsIn(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) stringsIn(child, out); return out }
  if (typeof node === 'object' && node.children) for (const child of node.children) stringsIn(child, out)
  return out
}

/** Find the first element whose props carry an onClick, to click it in tests. */
function clickables(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) clickables(child, out); return out }
  if (typeof node.props?.onClick === 'function') out.push(node)
  for (const child of node.children ?? []) clickables(child, out)
  return out
}

/** The label a clickable renders, so a test can pick a button by its text. */
function labelOf(node, tr) {
  const text = stringsIn(node).join('')
  return text
}

function stubFetch(handlers) {
  globalThis.fetch = async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${String(url)}`
    for (const [pattern, handler] of handlers) {
      if (key.includes(pattern) || String(url).includes(pattern)) return handler(url, init)
    }
    return { ok: true, json: async () => ({}) }
  }
}

const snapshotsResponse = () => ({
  ok: true,
  json: async () => ({
    snapshots: [{
      file: 'D:\\x\\data\\snapshot-20261015-172019-interval.json',
      name: 'snapshot-20261015-172019-interval.json',
      capturedAt: '2026-10-15T17:20:19.000+08:00',
      reason: 'interval',
      windows: 29,
      explorer: 5,
    }],
    broken: [],
  }),
})

function registerPage(mod) {
  let registered = null
  mod.apply({
    slots: { inject: (_n, fn) => fn(), register: (_m, render) => { registered = render } },
    get: () => undefined,
  })
  assert.ok(registered)
  return registered
}

test('a partial restore renders its report instead of an error', async () => {
  const { mod, mount } = await loadClient()
  stubFetch([
    ['/snapshots', snapshotsResponse],
    ['/restore', () => ({
      // The server's real contract: 500 when any item failed, with a report.
      ok: false,
      json: async () => ({
        plan: { launch: [], existing: [], manual: [], explorer: [], warnings: [] },
        report: {
          ok: false,
          launched: [{ name: 'chrome.exe', pid: 100 }],
          reopened: ['D:\\work'],
          placed: [{ title: 'a' }, { title: 'b' }],
          failed: [{ title: 'ROBOSTAR', stage: 'place', error: 'window not found' }],
          notes: [],
        },
      }),
    })],
  ])

  const page = registerPage(mod)
  const first = await mount(page, {})
  const restoreBtn = clickables(first).find(n => labelOf(n).includes('一键恢复'))
  assert.ok(restoreBtn, 'the restore button should be rendered')
  restoreBtn.props.onClick()

  // Let the click's promise chain resolve, then re-render.
  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))
  const tree = await mount(page, {}, { runEffects: false })
  const text = stringsIn(tree).join(' | ')

  // The successful work must be visible, not discarded behind an error.
  assert.match(text, /已定位窗口/, `the placed count should render; got: ${text}`)
  assert.match(text, /ROBOSTAR/, `the failed window should be listed; got: ${text}`)
  // And the error heading must not claim the snapshot list was unreadable.
  assert.ok(!text.includes('无法读取快照列表'),
    `a partial restore must not be reported as a snapshot-list failure; got: ${text}`)
})

test('a restore with no report at all still surfaces an error', async () => {
  const { mod, mount } = await loadClient()
  stubFetch([
    ['/snapshots', snapshotsResponse],
    ['/restore', () => ({ ok: false, json: async () => ({ error: 'boom' }) })],
  ])

  const page = registerPage(mod)
  const first = await mount(page, {})
  const restoreBtn = clickables(first).find(n => labelOf(n).includes('一键恢复'))
  restoreBtn.props.onClick()

  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))
  const tree = await mount(page, {}, { runEffects: false })
  const text = stringsIn(tree).join(' | ')

  assert.match(text, /恢复未完成/, `a real failure should be labelled as a restore failure; got: ${text}`)
  assert.match(text, /boom/)
})

test('a failed snapshot load is still labelled as a load failure', async () => {
  const { mod, mount } = await loadClient()
  stubFetch([
    ['/snapshots', () => ({ ok: false, status: 500, json: async () => ({ error: 'disk on fire' }) })],
  ])

  const page = registerPage(mod)
  const tree = await mount(page, {})
  const text = stringsIn(tree).join(' | ')

  assert.match(text, /无法读取快照列表/, `a load failure keeps its own label; got: ${text}`)
  assert.match(text, /disk on fire/)
})
