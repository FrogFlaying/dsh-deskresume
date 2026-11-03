/**
 * DeskResume — tests for the restore concurrency lock.
 *
 * A restore is a long, stateful sequence. Two overlapping runs (a double-clicked
 * button, a retried request, the GUI and the agent tool at once) would launch
 * duplicate applications and fight over window positions, so the second run must
 * be refused rather than silently allowed to interleave.
 *
 * The lock is exercised here without launching anything: a plan with no work in
 * it still has to acquire and release the lock.
 *
 * Run: node --test test/restore-lock.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { executeRestore } from '../lib/restore.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deskresume-lock-'))
}

/** A plan that does nothing, so the test never touches the desktop. */
function emptyPlan() {
  return { launch: [], existing: [], manual: [], explorer: [], warnings: [] }
}

function lockFile(root) {
  return path.join(root, '.dr-state', 'restore.lock')
}

test('a completed restore releases its lock', async () => {
  const root = tmpRoot()
  const report = await executeRestore(emptyPlan(), { rootDir: root, launch: false, place: false })
  assert.equal(report.ok, true)
  assert.ok(!fs.existsSync(lockFile(root)), 'lock should be gone after the run')
  fs.rmSync(root, { recursive: true, force: true })
})

test('a lock held by a live process makes the second restore refuse', async () => {
  const root = tmpRoot()
  const file = lockFile(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // This test process is alive by definition, so the lock must be respected.
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))

  const report = await executeRestore(emptyPlan(), { rootDir: root, launch: false, place: false })
  assert.equal(report.ok, false)
  assert.equal(report.locked, true)
  assert.match(report.failed[0].error, /already running/)
  // The refused run must not have deleted the other holder's lock.
  assert.ok(fs.existsSync(file), 'a refused restore must not clear the live lock')
  fs.rmSync(root, { recursive: true, force: true })
})

test('a stale lock from a dead process is taken over, not obeyed forever', async () => {
  const root = tmpRoot()
  const file = lockFile(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // An old timestamp plus a pid that cannot exist: a crashed run must not wedge
  // the feature permanently.
  fs.writeFileSync(file, JSON.stringify({
    pid: 999999, startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  }))

  const report = await executeRestore(emptyPlan(), { rootDir: root, launch: false, place: false })
  assert.equal(report.ok, true)
  assert.ok(report.notes.some(n => n.includes('接管')), 'takeover should be reported')
  assert.ok(!fs.existsSync(file))
  fs.rmSync(root, { recursive: true, force: true })
})

test('force runs even while another restore holds the lock', async () => {
  const root = tmpRoot()
  const file = lockFile(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))

  const report = await executeRestore(emptyPlan(), {
    rootDir: root, launch: false, place: false, force: true,
  })
  assert.equal(report.ok, true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a lock is released even when the run throws', async () => {
  const root = tmpRoot()
  // A plan whose window geometry forces the placement path to run; the missing
  // placement script is reported rather than thrown, but the lock must still go.
  const plan = {
    launch: [], existing: [], manual: [], explorer: [], warnings: [],
  }
  await executeRestore(plan, { rootDir: root, launch: false, place: true, settleMs: 0 })
  assert.ok(!fs.existsSync(lockFile(root)), 'lock must be released on the failure path too')
  fs.rmSync(root, { recursive: true, force: true })
})
