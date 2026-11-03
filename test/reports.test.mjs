/**
 * DeskResume — saved restore reports.
 *
 * A restore used to leave nothing behind: after the first real reboot the user
 * asked why QQ had not come back, and the only record was tool output that had
 * already scrolled away. These tests pin the properties that make a saved report
 * useful rather than a dump: it is found again, it is small, and it cannot be
 * used to read arbitrary files.
 *
 * Run: node test/reports.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  writeRestoreReport, listRestoreReports, readRestoreReport, trimPlan, reportDir,
} from '../lib/reports.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dr-reports-'))
}

const plan = {
  snapshotFile: 'data/snapshot-1-session-end.json',
  launch: [{
    key: 'c:\\wps.exe', name: 'wps.exe', exe: 'C:\\wps.exe', args: ['D:\\a.pdf'],
    windowCount: 2,
    windows: [
      { hwnd: '0x1', title: '网络策略申请记录表.xlsx - WPS Office', rect: { x: 1, y: 2, w: 3, h: 4 }, class: 'OpusApp' },
      { hwnd: '0x2', title: 'b.pdf - WPS Office', rect: { x: 5, y: 6, w: 7, h: 8 }, class: 'OpusApp' },
    ],
  }],
  existing: [],
  manual: [],
  explorer: [{ path: 'D:\\文档' }],
  warnings: ['注意这一点'],
}

const report = {
  ok: false,
  launched: [{ name: 'wps.exe', pid: 1 }],
  reopened: ['D:\\文档'],
  placed: [{ title: 'b.pdf - WPS Office', id: 1 }],
  failed: [{ stage: 'place', title: 'a.xlsx', error: 'window not found' }],
  pending: [{ name: 'QQ.exe', title: '会话', reason: 'login' }],
  documents: [{ app: 'wps.exe', path: 'D:\\文档\\周报.xlsx' }],
  documentsFailed: [],
  notes: ['一条说明'],
}

test('trimPlan keeps what explains a run and drops geometry', () => {
  const trimmed = trimPlan(plan)
  assert.equal(trimmed.snapshotFile, plan.snapshotFile)
  assert.equal(trimmed.launch.length, 1)
  assert.deepEqual(trimmed.launch[0].titles, [
    '网络策略申请记录表.xlsx - WPS Office', 'b.pdf - WPS Office',
  ])
  // Geometry is the largest part of a snapshot and never explains a failure.
  assert.equal(trimmed.launch[0].windows, undefined)
  assert.equal(trimmed.launch[0].rect, undefined)
  assert.deepEqual(trimmed.explorer, ['D:\\文档'])
})

test('a written report is found again and keeps every section', () => {
  const root = tmpRoot()
  try {
    const result = writeRestoreReport(root, { plan, report, snapshotFile: plan.snapshotFile })
    assert.equal(result.ok, true)
    assert.ok(fs.existsSync(result.file))
    assert.ok(result.file.startsWith(reportDir(root)))

    const saved = JSON.parse(fs.readFileSync(result.file, 'utf8'))
    assert.equal(saved.schemaVersion, 1)
    assert.equal(saved.ok, false)
    assert.equal(saved.plan.launch[0].name, 'wps.exe')
    assert.equal(saved.report.pending.length, 1)
    assert.equal(saved.report.documents.length, 1)
    assert.ok(saved.host.user)

    const list = listRestoreReports(root)
    assert.equal(list.reports.length, 1)
    assert.equal(list.reports[0].pending, 1)
    assert.equal(list.reports[0].documents, 1)
    assert.equal(list.reports[0].failed, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('retention keeps only the newest reports', () => {
  const root = tmpRoot()
  try {
    const dir = reportDir(root)
    fs.mkdirSync(dir, { recursive: true })
    for (const name of ['restore-20260101-000000.json', 'restore-20260102-000000.json', 'restore-20260103-000000.json']) {
      fs.writeFileSync(path.join(dir, name), JSON.stringify({ savedAt: name, report: {} }))
    }
    writeRestoreReport(root, { plan, report }, { keep: 2 })
    const rows = listRestoreReports(root).reports
    assert.equal(rows.length, 2)
    // The two most recent names survive; the oldest is pruned.
    assert.ok(!rows.some(r => r.name === 'restore-20260101-000000.json'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an unreadable report is listed as broken, not skipped silently', () => {
  const root = tmpRoot()
  try {
    const dir = reportDir(root)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'restore-broken.json'), '{not json')
    const list = listRestoreReports(root)
    assert.equal(list.reports.length, 0)
    assert.equal(list.broken.length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('reading a report outside the report directory is refused', () => {
  const root = tmpRoot()
  try {
    const outside = path.join(root, '..', 'secrets.json')
    assert.throws(() => readRestoreReport(root, outside), /refusing report outside/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a write failure is reported, never thrown', () => {
  // A file where the directory should be makes mkdirSync fail.
  const root = tmpRoot()
  try {
    fs.writeFileSync(path.join(root, 'data'), 'not a directory')
    const result = writeRestoreReport(root, { plan, report })
    assert.equal(result.ok, false)
    assert.ok(typeof result.error === 'string' && result.error.length > 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
