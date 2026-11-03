/**
 * DeskResume — placement rounds, login-gated windows, and inferred documents.
 *
 * The behaviours under test all come from one real failure report after a reboot:
 * "WPS 只打开了一个文档；QQ/微信的聊天框没有回来，因为重启时它们还没登录完".
 *
 * Nothing here spawns a process: `placeInRounds` takes the placement function as
 * an argument, so the round bookkeeping can be exercised without a desktop and
 * without PowerShell (which is also unavailable under the DSH sandbox).
 *
 * Run: node test/restore-rounds.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { executeRestore, placeInRounds, collectDocumentJobs, isLoginGated } from '../lib/restore.js'

function newReport() {
  return { launched: [], reopened: [], placed: [], failed: [], pending: [], documents: [], documentsFailed: [], notes: [] }
}

function request(id, app, title) {
  return { id, app, exe: `C:\\program files\\${app}`, title, class: null, state: 'normal', x: 0, y: 0, w: 800, h: 600, monitor: null }
}

test('stops after one round when everything was placed', async () => {
  const report = newReport()
  let calls = 0
  await placeInRounds([request(0, 'code.exe', 'a - Code')], {
    rootDir: os.tmpdir(), settleMs: 0, placeRetryMs: [0, 0], report,
    apply: async remaining => {
      calls++
      return { placed: remaining.map(r => ({ id: r.id, title: r.title })), failed: [], notes: [] }
    },
  })
  assert.equal(calls, 1)
  assert.equal(report.placed.length, 1)
  assert.equal(report.failed.length, 0)
})

test('retries and places a window that appears late', async () => {
  const report = newReport()
  let round = 0
  await placeInRounds([request(0, 'excel.exe', 'a.xlsx - Excel')], {
    rootDir: os.tmpdir(), settleMs: 0, placeRetryMs: [0, 0], report,
    apply: async () => {
      round++
      return round < 2
        ? { placed: [], failed: [{ id: 0, title: 'a.xlsx - Excel', error: 'window not found' }], notes: [] }
        : { placed: [{ id: 0, title: 'a.xlsx - Excel' }], failed: [], notes: [] }
    },
  })
  assert.equal(round, 2)
  assert.equal(report.placed.length, 1)
  assert.equal(report.failed.length, 0, 'a late window must not be reported as failed')
})

test('a window that never appears is a failure when the app does not need a login', async () => {
  const report = newReport()
  await placeInRounds([request(0, 'chrome.exe', '某页面 - Google Chrome')], {
    rootDir: os.tmpdir(), settleMs: 0, placeRetryMs: [0, 0], report,
    apply: async remaining => ({
      placed: [], notes: [],
      failed: remaining.map(r => ({ id: r.id, title: r.title, error: 'window not found', candidates: ['相似窗口'] })),
    }),
  })
  assert.equal(report.pending.length, 0)
  assert.equal(report.failed.length, 1)
  assert.equal(report.failed[0].stage, 'place')
  assert.deepEqual(report.failed[0].candidates, ['相似窗口'])
})

test('a window that never appears because the user has not logged in is pending, not failed', async () => {
  const report = newReport()
  await placeInRounds([request(0, 'QQ.exe', '微凉-PUBG交流群（禁商）等4个会话')], {
    rootDir: os.tmpdir(), settleMs: 0, placeRetryMs: [0, 0], report,
    apply: async remaining => ({
      placed: [], notes: [],
      failed: remaining.map(r => ({ id: r.id, title: r.title, error: 'window not found' })),
    }),
  })
  assert.equal(report.failed.length, 0, 'a login screen is not a placement failure')
  assert.equal(report.pending.length, 1)
  assert.equal(report.pending[0].reason, 'login')
  assert.ok(report.notes.some(n => n.includes('登录')))
})

test('login-gated apps are recognised by name or by executable', () => {
  assert.equal(isLoginGated({ name: 'QQ.exe' }), true)
  assert.equal(isLoginGated({ name: 'WeChat.exe' }), true)
  assert.equal(isLoginGated({ name: 'Weixin.exe' }), true)
  assert.equal(isLoginGated({ exe: 'D:\\Program Files\\Tencent\\QQ\\Bin\\QQ.exe' }), true)
  assert.equal(isLoginGated({ name: 'chrome.exe' }), false)
  assert.equal(isLoginGated(null), false)
})

test('document jobs come from launch and existing only, never from manual', () => {
  const doc = { name: 'a.xlsx', path: 'D:\\a.xlsx' }
  const jobs = collectDocumentJobs({
    launch: [{ name: 'wps.exe', exe: 'C:\\wps.exe', inferredDocuments: [doc] }],
    existing: [{ name: 'wps.exe', exe: 'C:\\wps.exe', inferredDocuments: [doc, { name: 'b.pdf', path: 'D:\\b.pdf' }] }],
    manual: [{ name: 'taskmgr.exe', exe: null, inferredDocuments: [doc] }],
  })
  assert.equal(jobs.length, 3)
  assert.ok(jobs.every(j => j.entry.exe))
})

test('executeRestore writes a report it can be asked about later', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-restore-'))
  try {
    const plan = {
      launch: [], existing: [], manual: [], explorer: [],
      warnings: [], snapshotFile: 'data/snapshot-x.json',
    }
    const report = await executeRestore(plan, { rootDir: root, launch: false, place: false, settleMs: 0 })
    assert.equal(report.ok, true)
    assert.ok(report.reportFile, 'a restore must leave a report on disk')
    assert.ok(fs.existsSync(report.reportFile))

    const saved = JSON.parse(fs.readFileSync(report.reportFile, 'utf8'))
    assert.equal(saved.snapshotFile, 'data/snapshot-x.json')
    assert.equal(saved.ok, true)
    assert.ok(Array.isArray(saved.report.notes))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a restore refused by the lock launches nothing and claims nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-restore-'))
  try {
    fs.mkdirSync(path.join(root, '.dr-state'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.dr-state', 'restore.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    )
    const report = await executeRestore(
      { launch: [], existing: [], manual: [], explorer: [], warnings: [] },
      { rootDir: root, launch: false, place: false },
    )
    assert.equal(report.locked, true)
    assert.equal(report.ok, false)
    assert.equal(report.placed.length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
