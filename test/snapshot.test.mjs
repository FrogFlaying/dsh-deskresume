/**
 * DeskResume — unit tests for the snapshot/restore planner.
 *
 * These run with plain `node --test`, no DSH and no Windows API, because
 * lib/snapshot.js is deliberately pure. Fixtures are synthesised in memory so a
 * test failure means the planner is wrong, not that the machine's desktop
 * happened to look different.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  groupByProcess, planRestore, summarizeSnapshot, relaunchArgs,
  readSnapshot, listSnapshots, pickSnapshot, dataDir, SNAPSHOT_SCHEMA_VERSION,
} from '../lib/snapshot.js'

/** A snapshot shaped exactly like collector/collect.ps1 emits. */
function fixture(overrides = {}) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    capturedAt: '2026-10-14T09:00:00.000Z',
    reason: 'manual',
    host: { os: {}, screens: [{ device: '\\\\.\\DISPLAY1' }] },
    stats: { windows: 4, withCommandLine: 3, explorerWindows: 1, screens: 1 },
    windows: [
      {
        hwnd: '0x1', pid: 100, title: 'doc.txt - Notepad++', name: 'notepad++.exe',
        exe: 'C:\\Program Files\\Notepad++\\notepad++.exe',
        commandLine: '"C:\\Program Files\\Notepad++\\notepad++.exe" "D:\\a\\doc.txt"',
        args: ['D:\\a\\doc.txt'], state: 'normal',
        rect: { x: 100, y: 100, w: 800, h: 600 },
        normalRect: { x: 100, y: 100, w: 800, h: 600 },
        monitor: '0,0,1920,1080', class: 'Notepad++',
      },
      {
        hwnd: '0x2', pid: 200, title: 'Proj - Visual Studio Code', name: 'Code.exe',
        exe: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
        commandLine: '"C:\\...\\Code.exe" "D:\\proj"', args: ['D:\\proj'],
        state: 'maximized',
        rect: { x: -8, y: -8, w: 1936, h: 1096 },
        normalRect: { x: 50, y: 50, w: 1200, h: 800 },
        monitor: '0,0,1920,1080', class: 'Chrome_WidgetWin_1',
      },
      {
        hwnd: '0x3', pid: 3928, title: 'C:\\Users\\me', name: 'explorer.exe',
        exe: 'C:\\Windows\\explorer.exe', commandLine: 'C:\\Windows\\Explorer.EXE',
        args: [], state: 'normal',
        rect: { x: 0, y: 0, w: 900, h: 700 }, normalRect: { x: 0, y: 0, w: 900, h: 700 },
        monitor: '0,0,1920,1080', class: 'CabinetWClass',
      },
      {
        hwnd: '0x4', pid: 999, title: 'Microsoft Text Input Application', name: 'TextInputHost.exe',
        exe: 'C:\\Windows\\SystemApps\\TextInputHost.exe', commandLine: null, args: [],
        state: 'normal', rect: { x: 0, y: 0, w: 10, h: 10 },
        normalRect: { x: 0, y: 0, w: 10, h: 10 }, monitor: '', class: 'Windows.UI.Core.CoreWindow',
      },
      {
        // A process that is NOT on the process exclusion list but whose title is
        // transient UI: this is what exercises the title-exclusion path.
        hwnd: '0x6', pid: 1000, title: 'Default IME', name: 'someapp.exe',
        exe: 'C:\\Apps\\someapp.exe', commandLine: '"C:\\Apps\\someapp.exe"', args: [],
        state: 'normal', rect: { x: 0, y: 0, w: 20, h: 20 },
        normalRect: { x: 0, y: 0, w: 20, h: 20 }, monitor: '', class: 'IME',
      },
    ],
    explorer: [{ path: 'D:\\Documents', url: 'file:///D:/Documents', hwnd: 5 }],
    ...overrides,
  }
}

test('groupByProcess drops shell/infrastructure windows but keeps user apps', () => {
  const { apps, skipped } = groupByProcess(fixture())
  const names = apps.map(a => a.name).sort()
  assert.deepEqual(names, ['Code.exe', 'notepad++.exe'])
  // explorer.exe and the IME host must be filtered out, with a reason recorded.
  assert.ok(skipped.some(s => s.reason === 'excluded-process' && s.detail === 'explorer.exe'))
  assert.ok(skipped.some(s => s.reason === 'excluded-title'))
})

test('groupByProcess collapses multiple windows of one process into one app', () => {
  const doc = fixture()
  doc.windows.push({
    hwnd: '0x9', pid: 200, title: 'other - Visual Studio Code', name: 'Code.exe',
    exe: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    commandLine: '"C:\\...\\Code.exe" "D:\\proj"', args: ['D:\\proj'],
    state: 'normal', rect: { x: 0, y: 0, w: 800, h: 600 },
    normalRect: { x: 0, y: 0, w: 800, h: 600 }, monitor: '0,0,1920,1080', class: 'Chrome_WidgetWin_1',
  })
  const { apps } = groupByProcess(doc)
  const code = apps.find(a => a.name === 'Code.exe')
  assert.equal(code.windowCount, 2)
})

test('relaunchArgs keeps document paths and drops session-specific switches', () => {
  const ok = relaunchArgs({ args: ['D:\\proj', '--new-window'] })
  assert.deepEqual(ok, ['D:\\proj'])

  // A Chromium helper process must never be relaunched on its own.
  const helper = relaunchArgs({ args: ['--type=renderer', '--user-data-dir=C:\\x'] })
  assert.deepEqual(helper, [])
})

test('planRestore separates launch, existing and manual, and never double-launches', () => {
  const doc = fixture()
  // Code.exe is already running; notepad++ is not.
  const plan = planRestore(doc, { runningProcesses: ['code.exe'] })

  assert.deepEqual(plan.launch.map(e => e.name), ['notepad++.exe'])
  assert.deepEqual(plan.existing.map(e => e.name), ['Code.exe'])
  assert.equal(plan.manual.length, 0)
  assert.deepEqual(plan.explorer.map(f => f.path), ['D:\\Documents'])
})

test('planRestore marks a single-instance app as manual instead of launching it', () => {
  const doc = fixture()
  doc.windows = [{
    hwnd: '0x5', pid: 300, title: 'Task Manager', name: 'Taskmgr.exe',
    exe: 'C:\\Windows\\System32\\Taskmgr.exe',
    commandLine: '"Taskmgr.exe"', args: [], state: 'normal',
    rect: { x: 10, y: 10, w: 900, h: 600 }, normalRect: { x: 10, y: 10, w: 900, h: 600 },
    monitor: '0,0,1920,1080', class: 'TaskManagerWindow',
  }]
  const plan = planRestore(doc, { runningProcesses: [] })
  assert.equal(plan.launch.length, 0)
  assert.equal(plan.manual.length, 1)
  assert.match(plan.manual[0].note, /单实例/)
})

test('planRestore always warns that unsaved content is unrecoverable', () => {
  const plan = planRestore(fixture(), { runningProcesses: [] })
  assert.ok(plan.warnings.some(w => w.includes('未保存')))
})

test('planRestore reports windows whose command line could not be read', () => {
  const doc = fixture()
  doc.stats = { windows: 10, withCommandLine: 4, explorerWindows: 0, screens: 1 }
  const plan = planRestore(doc, { runningProcesses: [] })
  assert.ok(plan.warnings.some(w => w.includes('6 个窗口没有读到命令行')))
})

test('planRestore honours the only filter', () => {
  const plan = planRestore(fixture(), { runningProcesses: [], only: ['code.exe'] })
  assert.deepEqual(plan.launch.map(e => e.name), ['Code.exe'])
})

test('planRestore deduplicates repeated explorer folders', () => {
  const doc = fixture()
  doc.explorer = [
    { path: 'D:\\Documents' },
    { path: 'd:\\documents' },
    { path: 'D:\\Other' },
  ]
  const plan = planRestore(doc, { runningProcesses: [] })
  assert.equal(plan.explorer.length, 2)
})

test('readSnapshot rejects a newer schema version instead of guessing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskresume-test-'))
  const file = path.join(dir, 'snapshot-bad.json')
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, windows: [] }))
  // A snapshot from a newer build must be refused rather than half-read; the
  // message has to say what to do, because deleting the file may destroy the
  // only record of a session.
  assert.throws(() => readSnapshot(file), /newer than this build supports/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('listSnapshots reports unparseable files rather than dropping them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskresume-test-'))
  const dataRoot = path.join(dir, 'proj')
  fs.mkdirSync(dataDir(dataRoot), { recursive: true })
  fs.writeFileSync(path.join(dataDir(dataRoot), 'snapshot-good.json'), JSON.stringify(fixture()))
  fs.writeFileSync(path.join(dataDir(dataRoot), 'snapshot-broken.json'), '{ not json')

  const list = listSnapshots(dataRoot)
  assert.equal(list.snapshots.length, 1)
  assert.equal(list.broken.length, 1)
  assert.match(list.broken[0].name, /broken/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('pickSnapshot prefers the pre-shutdown capture after a power loss', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskresume-test-'))
  const dataRoot = path.join(dir, 'proj')
  fs.mkdirSync(dataDir(dataRoot), { recursive: true })
  // The interval snapshot is newer on disk, but session-end is the meaningful one.
  fs.writeFileSync(path.join(dataDir(dataRoot), 'snapshot-1-interval.json'),
    JSON.stringify(fixture({ reason: 'interval' })))
  fs.writeFileSync(path.join(dataDir(dataRoot), 'snapshot-2-session-end.json'),
    JSON.stringify(fixture({ reason: 'session-end' })))

  const picked = pickSnapshot(dataRoot)
  assert.match(picked, /session-end/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('summarizeSnapshot gives counts the UI and agent both use', () => {
  const s = summarizeSnapshot(fixture())
  assert.equal(s.windows, 5)
  assert.equal(s.apps, 2)
  assert.equal(s.explorer, 1)
  assert.ok(s.topApps.length >= 1)
})
