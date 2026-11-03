/**
 * Tests for the DeskResume settings page language.
 *
 * The page rendered in English for a Chinese user, while the plugin next to it in
 * the same sidebar rendered Chinese. The cause was not a missing translation —
 * the zh dictionary was complete — but the language lookup: it tried one
 * accessor (`ctx.locale.current()`) that this shell does not expose, and then
 * fell back to English. Every lookup failed, so the fallback decided the
 * language.
 *
 * These tests run the real client.js in a minimal React runtime and inspect the
 * strings it actually renders, so they fail if English leaks back in. A test of a
 * copied decision function would not catch that.
 *
 * Run: node --test test/client-i18n.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const clientPath = `file:///${path.join(rootDir, 'client.js').replace(/\\/g, '/')}`

/**
 * A minimal React whose hooks work, so a component can actually be rendered.
 *
 * One hookful component is rendered at a time, so a single hook cursor reset
 * before each component invocation is enough.
 */
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

  /** Expand function components so the tree contains real host elements. */
  function expand(node) {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(expand)
    if (typeof node.type === 'function') {
      runtime.index = 0                    // one hookful component per render
      return expand(node.type(node.props))
    }
    return { ...node, children: (node.children ?? []).map(expand) }
  }

  /** Render, flush effects, let promises settle, render again. */
  async function mount(Component, props) {
    runtime.index = 0
    runtime.effects = []
    expand(Component(props))

    const queued = runtime.effects
    runtime.effects = []
    for (const fn of queued) fn()

    // Two macrotask turns: enough for the stubbed fetch chain to resolve.
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    runtime.index = 0
    runtime.effects = []
    return expand(Component(props))
  }

  return { React, mount }
}

/** Load client.js and return its module plus the React stub it was built with. */
async function loadClient() {
  let captured = null
  globalThis.window = {
    __ModuleLoader__: { load: spec => { captured = spec } },
    confirm: () => true,
  }

  await import(`${clientPath}?v=${Math.random()}`)
  assert.ok(captured, 'client.js should register itself with the ModuleLoader')
  assert.equal(captured.id, 'dsh-deskresume')

  const { React, mount } = makeReact()
  const mod = captured.factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected require("${name}")`)
  })
  return { mod, mount }
}

/** Collect every string a rendered tree contains. */
function stringsIn(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) stringsIn(child, out); return out }
  if (typeof node === 'object' && node.children) for (const child of node.children) stringsIn(child, out)
  return out
}

/** A ctx with no locale accessor at all — the situation that caused the bug. */
const ctxWithoutLocale = () => ({ slots: {}, get: () => undefined })

/** A ctx that exposes locale the way this shell actually does. */
const ctxWithLocale = tag => ({
  slots: {},
  get: name => (name === 'locale' ? { get: () => tag, locale: tag } : undefined),
})

/**
 * One snapshot, so the page renders its full body rather than the loading line.
 *
 * The file name is in the real collector format. An earlier fixture used
 * "snapshot-1-interval.json", which `snapshotLabel` cannot parse, so the label
 * test failed against the fixture rather than the code.
 */
function stubFetch() {
  globalThis.fetch = async url => {
    if (String(url).includes('/snapshots')) {
      return {
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
      }
    }
    return { ok: true, json: async () => ({}) }
  }
}

/**
 * Register the settings section and hand back the page component.
 *
 * The locale belongs on the OUTER context — the one passed to `apply(ctx)` — not
 * on the render props. The section is wired as
 *
 *     props => h(DeskResumePage, { ...props, ctx })
 *
 * so the closure `ctx` overwrites any `ctx` a caller passes as a prop. An earlier
 * version of this harness put the locale on the props, which meant every case
 * rendered the same language and the English case failed for the wrong reason.
 * The outer context is what the component actually reads.
 */
function registerPage(mod, outerCtx) {
  let registered = null
  mod.apply({
    ...outerCtx,
    slots: {
      inject: (_name, fn) => fn(),
      register: (_meta, render) => { registered = render },
    },
  })
  assert.ok(registered, 'the page component should be registered')
  return registered
}

test('renders Chinese when the shell exposes no locale accessor', async () => {
  // The exact regression: an unreadable locale must NOT mean English.
  const { mod, mount } = await loadClient()
  stubFetch()

  const page = registerPage(mod, ctxWithoutLocale())
  const tree = await mount(page, {})
  const text = stringsIn(tree).join(' | ')

  assert.match(text, /桌面续开/, `title should be Chinese, got: ${text}`)
  assert.match(text, /立即快照/, 'the capture button should be Chinese')
  assert.match(text, /快照/, 'the snapshots heading should be Chinese')

  for (const english of ['Snapshot now', 'Refresh', 'Snapshots', 'Captured', 'Reason', 'Windows', 'Folders']) {
    assert.ok(!text.includes(english), `English leaked into the Chinese page: "${english}"`)
  }
})

test('renders Chinese when the shell reports a zh locale', async () => {
  const { mod, mount } = await loadClient()
  stubFetch()

  const page = registerPage(mod, ctxWithLocale('zh-CN'))
  const tree = await mount(page, {})
  const text = stringsIn(tree).join(' | ')

  assert.match(text, /桌面续开/, `got: ${text}`)
  assert.match(text, /立即快照/)
})

test('renders English when the shell reports an en locale', async () => {
  // English must still work; the fix is the fallback, not removing English.
  const { mod, mount } = await loadClient()
  stubFetch()

  const page = registerPage(mod, ctxWithLocale('en-US'))
  const tree = await mount(page, {})
  const text = stringsIn(tree).join(' | ')

  assert.match(text, /Snapshot now/, `got: ${text}`)
  assert.ok(!text.includes('立即快照'), 'Chinese must not appear in the English page')
})

test('the sidebar label is Chinese without a readable locale', async () => {
  const { mod } = await loadClient()
  let meta = null
  mod.apply({ slots: { inject: (_n, fn) => fn(), register: (m, _r) => { meta = m } } })
  assert.equal(typeof meta.label, 'function')
  assert.equal(meta.label(), '桌面续开')
})

test('reason labels are translated, not raw', async () => {
  const { mod, mount } = await loadClient()
  stubFetch()

  const page = registerPage(mod, ctxWithoutLocale())
  const tree = await mount(page, {})
  const text = stringsIn(tree).join(' | ')

  assert.match(text, /定时/, 'reason=interval should render as 定时, not the raw value')
  assert.ok(!/Reason interval/.test(text), 'the raw English reason must not appear')
})

test('snapshot cards show readable time, not a raw file name or ISO stamp', async () => {
  const { mod, mount } = await loadClient()
  stubFetch()

  const page = registerPage(mod, ctxWithoutLocale())
  const tree = await mount(page, {})
  const text = stringsIn(tree).join(' | ')

  // The raw artefact name repeats the date already shown and the reason already
  // translated, so it should not be the card's label.
  assert.ok(!text.includes('snapshot-1-interval.json'), `raw file name leaked: ${text}`)
  assert.ok(!text.includes('2026-10-15T17:20:19'), `raw ISO timestamp leaked: ${text}`)

  // The label should be a readable local time and a relative age.
  assert.match(text, /2026-10-15 17:20:19/, 'a readable timestamp should be shown')
  assert.match(text, /(前|刚刚)/, 'a relative age should be shown')
})

test('the Chinese title contains no product name in English', async () => {
  const { mod, mount } = await loadClient()
  stubFetch()

  const page = registerPage(mod, ctxWithoutLocale())
  const tree = await mount(page, {})
  const text = stringsIn(tree).join(' | ')

  // The title previously read "桌面续开 DeskResume".
  assert.ok(!text.includes('DeskResume'), `English product name leaked into the Chinese title: ${text}`)
})
