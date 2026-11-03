/**
 * DeskResume — inferred documents.
 *
 * The titles below are verbatim from this machine's snapshots: WPS Office keeps
 * five documents in one top-level window, so the observed title is whichever tab
 * was active when the interval snapshot fired. These cases are the difference
 * between "restore one file" and "restore the files the user was working in".
 *
 * Run: node test/documents.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  documentNameFromTitle, cleanTitle, buildTitleHistory, buildRecentIndex,
  resolveDocumentPath, annotateInferredDocuments, plannedDocumentPaths, titleHistoryFromFiles,
} from '../lib/documents.js'

const WPS_EXE = 'C:\\Program Files (x86)\\Kingsoft Office Software\\WPS Office\\12.1.0.16120\\office6\\wps.exe'

test('extracts the document name from a WPS title', () => {
  assert.deepEqual(
    documentNameFromTitle('网络策略申请记录表.xlsx - WPS Office'),
    { name: '网络策略申请记录表.xlsx', path: null },
  )
})

test('strips the read-only marker WPS puts in front', () => {
  assert.deepEqual(
    documentNameFromTitle('[只读]HTTPS卸载配置信息-数字化营销支持凭条.xlsx - WPS Office'),
    { name: 'HTTPS卸载配置信息-数字化营销支持凭条.xlsx', path: null },
  )
})

test('keeps spaced hyphens out of the file name', () => {
  // The real title contains "8.4万字" — dots and hyphens that are part of the name.
  assert.deepEqual(
    documentNameFromTitle('940个支付名词大全-8.4万字-陈天宇支付学院出品.pdf - WPS Office'),
    { name: '940个支付名词大全-8.4万字-陈天宇支付学院出品.pdf', path: null },
  )
})

test('strips the unsaved-changes asterisk (Typora)', () => {
  assert.deepEqual(
    documentNameFromTitle('*06_2_储备项目接口文档.md - Typora'),
    { name: '06_2_储备项目接口文档.md', path: null },
  )
})

test('ignores a title that carries no document', () => {
  // Both observed verbatim: WPS with no document open, and Notepad++ without a file.
  assert.equal(documentNameFromTitle('WPS Office - WPS Office'), null)
  assert.equal(documentNameFromTitle('C:\\Users\\someone\\Desktop\\plan - Notepad++'), null)
  assert.equal(documentNameFromTitle('微信'), null)
  assert.equal(documentNameFromTitle(''), null)
  assert.equal(documentNameFromTitle(null), null)
})

test('accepts a full path when the title carries one', () => {
  assert.deepEqual(
    documentNameFromTitle('D:\\文档\\note\\周报.txt - 记事本'),
    { name: '周报.txt', path: 'D:\\文档\\note\\周报.txt' },
  )
})

test('cleanTitle is idempotent and only strips leading markers', () => {
  assert.equal(cleanTitle('[只读][共享]a.xlsx - WPS Office'), 'a.xlsx - WPS Office')
  assert.equal(cleanTitle('a.xlsx - WPS Office'), 'a.xlsx - WPS Office')
})

test('history counts repeats and remembers the newest sighting', () => {
  const docs = [
    {
      capturedAt: '2026-10-23T08:00:00.000Z',
      windows: [
        { exe: WPS_EXE, name: 'wps.exe', title: 'A.xlsx - WPS Office' },
        { exe: WPS_EXE, name: 'wps.exe', title: 'B.pdf - WPS Office' },
      ],
    },
    {
      capturedAt: '2026-10-23T08:10:00.000Z',
      windows: [{ exe: WPS_EXE, name: 'wps.exe', title: 'A.xlsx - WPS Office' }],
    },
  ]
  const history = buildTitleHistory(docs, { now: Date.parse('2026-10-23T09:00:00.000Z') })
  const group = history.get(WPS_EXE.toLowerCase())
  assert.ok(group)
  assert.equal(group.titles.size, 2)
  assert.equal(group.titles.get('a.xlsx - wps office').count, 2)
  assert.equal(group.titles.get('b.pdf - wps office').count, 1)
})

test('history ignores snapshots older than the window', () => {
  const docs = [
    { capturedAt: '2026-10-20T00:00:00.000Z', windows: [{ exe: WPS_EXE, title: 'old.xlsx - WPS Office' }] },
    { capturedAt: '2026-10-23T08:00:00.000Z', windows: [{ exe: WPS_EXE, title: 'new.xlsx - WPS Office' }] },
  ]
  const history = buildTitleHistory(docs, {
    withinMs: 6 * 3600 * 1000,
    now: Date.parse('2026-10-23T09:00:00.000Z'),
  })
  const titles = [...history.get(WPS_EXE.toLowerCase()).titles.keys()]
  assert.deepEqual(titles, ['new.xlsx - wps office'])
})

test('titleHistoryFromFiles skips files older than the window', () => {
  const calls = []
  const files = ['old.json', 'new.json']
  const mtimes = { 'old.json': 1000, 'new.json': 5000 }
  const realStat = fs.statSync
  // The files do not exist; stub statSync for this assertion only.
  fs.statSync = p => ({ mtimeMs: mtimes[p] ?? 0 })
  try {
    const history = titleHistoryFromFiles(files, file => {
      calls.push(file)
      return { capturedAt: '2026-10-23T08:00:00.000Z', windows: [{ exe: WPS_EXE, title: 'x.xlsx - WPS Office' }] }
    }, { withinMs: 100, now: 5050 })
    assert.deepEqual(calls, ['new.json'])
    assert.equal(history.size, 1)
  } finally {
    fs.statSync = realStat
  }
})

test('recent index resolves a file name to the newest existing path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-docs-'))
  try {
    const older = path.join(dir, 'older', '报告.xlsx')
    const newer = path.join(dir, 'newer', '报告.xlsx')
    fs.mkdirSync(path.dirname(older), { recursive: true })
    fs.mkdirSync(path.dirname(newer), { recursive: true })
    fs.writeFileSync(older, 'x')
    fs.writeFileSync(newer, 'x')

    const index = buildRecentIndex({
      entries: [
        { name: '报告.xlsx', path: older, modifiedMs: 1000 },
        { name: '报告.xlsx', path: newer, modifiedMs: 2000 },
      ],
    })
    assert.equal(index.byName.get('报告.xlsx').length, 2)
    assert.equal(resolveDocumentPath({ name: '报告.xlsx', path: null }, index), newer)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolution never returns a path that no longer exists', () => {
  const index = buildRecentIndex({ entries: [{ name: 'gone.xlsx', path: 'Z:\\nowhere\\gone.xlsx', modifiedMs: 1 }] })
  assert.equal(resolveDocumentPath({ name: 'gone.xlsx', path: null }, index), null)
  assert.equal(resolveDocumentPath({ name: 'missing.xlsx', path: null }, index), null)
  assert.equal(resolveDocumentPath(null, index), null)
})

test('annotation attaches inferred documents in newest-first order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-docs-'))
  try {
    const a = path.join(dir, 'a.xlsx')
    const b = path.join(dir, 'b.pdf')
    fs.writeFileSync(a, 'x')
    fs.writeFileSync(b, 'x')

    const history = buildTitleHistory([
      {
        capturedAt: '2026-10-23T08:00:00.000Z',
        windows: [
          { exe: WPS_EXE, name: 'wps.exe', title: 'a.xlsx - WPS Office' },
          { exe: WPS_EXE, name: 'wps.exe', title: 'b.pdf - WPS Office' },
        ],
      },
      { capturedAt: '2026-10-23T08:10:00.000Z', windows: [{ exe: WPS_EXE, name: 'wps.exe', title: 'b.pdf - WPS Office' }] },
    ], { now: Date.parse('2026-10-23T09:00:00.000Z') })

    const recentIndex = buildRecentIndex({
      entries: [
        { name: 'a.xlsx', path: a, modifiedMs: 1 },
        { name: 'b.pdf', path: b, modifiedMs: 2 },
      ],
    })

    const plan = {
      launch: [{
        key: WPS_EXE.toLowerCase(), name: 'wps.exe', exe: WPS_EXE, args: [], windows: [], windowCount: 1,
      }],
      existing: [],
      manual: [],
    }

    const added = annotateInferredDocuments(plan, {
      history, recentIndex, apps: ['wps.exe'], limit: 8,
      alreadyPlanned: new Set(plannedDocumentPaths(plan)),
    })

    assert.equal(added.total, 2)
    assert.deepEqual(plan.launch[0].inferredDocuments.map(d => d.path), [b, a])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('annotation ignores apps that are not document editors', () => {
  const history = buildTitleHistory([{
    capturedAt: '2026-10-23T08:00:00.000Z',
    windows: [{ exe: 'C:\\chrome.exe', name: 'chrome.exe', title: '某个页面.xlsx - Google Chrome' }],
  }], { now: Date.parse('2026-10-23T09:00:00.000Z') })

  const plan = { launch: [{ key: 'c:\\chrome.exe', name: 'chrome.exe', exe: 'C:\\chrome.exe', args: [], windows: [] }], existing: [], manual: [] }
  const added = annotateInferredDocuments(plan, {
    history, recentIndex: buildRecentIndex({ entries: [] }), apps: ['wps.exe'],
  })
  assert.equal(added.total, 0)
  assert.equal(plan.launch[0].inferredDocuments, undefined)
})

test('annotation never duplicates a document the command line already opens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-docs-'))
  try {
    const doc = path.join(dir, 'a.xlsx')
    fs.writeFileSync(doc, 'x')
    const history = buildTitleHistory([{
      capturedAt: '2026-10-23T08:00:00.000Z',
      windows: [{ exe: WPS_EXE, name: 'wps.exe', title: 'a.xlsx - WPS Office' }],
    }], { now: Date.parse('2026-10-23T09:00:00.000Z') })

    const plan = {
      launch: [{ key: WPS_EXE.toLowerCase(), name: 'wps.exe', exe: WPS_EXE, args: [doc], windows: [] }],
      existing: [], manual: [],
    }
    const added = annotateInferredDocuments(plan, {
      history,
      recentIndex: buildRecentIndex({ entries: [{ name: 'a.xlsx', path: doc, modifiedMs: 1 }] }),
      apps: ['wps.exe'],
      alreadyPlanned: new Set(plannedDocumentPaths(plan)),
    })
    assert.equal(added.total, 0)
    assert.equal(plan.launch[0].inferredDocuments, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('annotation honours the per-app cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-docs-'))
  try {
    const docs = []
    const windows = []
    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, `d${i}.xlsx`)
      fs.writeFileSync(p, 'x')
      docs.push({ name: `d${i}.xlsx`, path: p, modifiedMs: i })
      windows.push({ exe: WPS_EXE, name: 'wps.exe', title: `d${i}.xlsx - WPS Office` })
    }
    const history = buildTitleHistory(
      [{ capturedAt: '2026-10-23T08:00:00.000Z', windows }],
      { now: Date.parse('2026-10-23T09:00:00.000Z') },
    )
    const plan = { launch: [{ key: WPS_EXE.toLowerCase(), name: 'wps.exe', exe: WPS_EXE, args: [], windows: [] }], existing: [], manual: [] }
    const added = annotateInferredDocuments(plan, {
      history, recentIndex: buildRecentIndex({ entries: docs }), apps: ['wps.exe'], limit: 2,
    })
    assert.equal(added.total, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('plannedDocumentPaths only reports absolute paths', () => {
  const plan = {
    launch: [{ args: ['D:\\a.xlsx', '--flag', 'https://x.test/a'] }],
    existing: [{ args: ['\\\\server\\share\\b.pdf'] }],
    manual: [],
  }
  assert.deepEqual(plannedDocumentPaths(plan), ['D:\\a.xlsx', '\\\\server\\share\\b.pdf'])
})
