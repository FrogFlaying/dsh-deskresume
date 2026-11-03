/**
 * DeskResume — end-to-end smoke test of the placement round trip.
 *
 * This is the one test that exercises real Windows APIs. It asks place.ps1 to
 * move a window to the exact rectangle it already occupies, so the desktop does
 * not visibly change, while still proving:
 *   - the JSON handoff works (including a non-ASCII title, the encoding trap)
 *   - title matching finds the right window
 *   - the monitor-clamp path reports correctly
 *   - a title that does not exist is reported as unmatched, not silently ignored
 *
 * Run: node test/place.smoke.mjs
 */

import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * Capture a fresh snapshot via the real collector.
 *
 * Written to a temp file rather than the default data/ location: the collector
 * would otherwise drop a snapshot into the user's real snapshot store on every
 * test run, mixing test noise into the history a restore picks from.
 */
async function snapshot() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskresume-smoke-snap-'))
  const outFile = path.join(tmpDir, 'snapshot.json')

  const { stdout } = await run(POWERSHELL, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(rootDir, 'collector', 'collect.ps1'),
    '-Reason', 'manual', '-Quiet', '-Keep', '0', '-OutFile', outFile,
  ], { maxBuffer: 16 * 1024 * 1024 })

  const line = String(stdout).split(/\r?\n/).filter(l => l.trim().startsWith('{')).pop()
  if (!line) throw new Error('collector produced no summary')
  const summary = JSON.parse(line)
  const doc = JSON.parse(fs.readFileSync(summary.outFile, 'utf8'))
  return { summary, doc, outFile: summary.outFile, tmpDir }
}

/** Run place.ps1 over a request list and return its parsed result. */
async function place(requests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskresume-smoke-'))
  const inFile = path.join(dir, 'in.json')
  const outFile = path.join(dir, 'out.json')
  fs.writeFileSync(inFile, JSON.stringify(requests), 'utf8')

  await run(POWERSHELL, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(rootDir, 'collector', 'place.ps1'),
    '-Json', inFile, '-Out', outFile,
  ], { maxBuffer: 16 * 1024 * 1024 })

  const result = JSON.parse(fs.readFileSync(outFile, 'utf8'))
  fs.rmSync(dir, { recursive: true, force: true })
  return result
}

console.log('DeskResume placement smoke test')
console.log('')

const { summary, doc, tmpDir } = await snapshot()
console.log(`collector: ${summary.stats.windows} windows, ${summary.stats.withCommandLine} with command line`)
check('collector produced windows', summary.stats.windows > 0)
check('collector read exe paths for every window',
  summary.stats.withExePath === summary.stats.windows,
  `${summary.stats.withExePath}/${summary.stats.windows}`)
check('collector read command lines for every window',
  summary.stats.withCommandLine === summary.stats.windows,
  `${summary.stats.withCommandLine}/${summary.stats.windows}`)

// Pick a real application window. Minimized windows are preferred: moving one
// exercises title matching and clamping while leaving it minimized, so the
// screen does not visibly change. Shell surfaces are excluded because moving
// them proves nothing about restoring a user's app.
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'])
const isAppWindow = w =>
  w.rect && w.rect.w > 200 && w.rect.h > 200 &&
  w.class && !SHELL_CLASSES.has(w.class) &&
  String(w.name ?? '').toLowerCase() !== 'explorer.exe' &&
  w.title && w.title !== 'Program Manager'

const target = doc.windows.find(w => w.state === 'minimized' && isAppWindow(w))
  ?? doc.windows.find(w => w.state === 'normal' && isAppWindow(w))

if (!target) {
  console.log('  SKIP  no suitable application window to test placement against')
} else {
  // A minimized window keeps its geometry in normalRect and stays minimized,
  // so the placement is observable but not visually disruptive.
  const useRect = (target.state === 'minimized' ? target.normalRect : target.rect) ?? target.rect
  const restoreState = target.state
  const restoreRect = useRect
  console.log(`target window: "${target.title}" [${target.state}]${/[^\x00-\x7f]/.test(target.title) ? '  (non-ASCII title)' : ''}`)

  // 1. Move it to exactly where it already belongs: a true no-op.
  const same = await place([{
    title: target.title, class: target.class, state: restoreState,
    x: restoreRect.x, y: restoreRect.y, w: restoreRect.w, h: restoreRect.h,
    monitor: target.monitor,
  }])
  check('placement matched the window by title', same.placed.length === 1,
    `placed=${same.placed.length} failed=${JSON.stringify(same.failed)}`)
  if (same.placed.length === 1) {
    check('no-op placement reported no clamping', same.placed[0].clamped === false)
  }

  // 2. An off-screen rectangle must be clamped, and said so.
  const clamped = await place([{
    title: target.title, class: target.class, state: restoreState,
    x: 99999, y: 99999, w: restoreRect.w, h: restoreRect.h,
    monitor: target.monitor,
  }])
  check('off-screen target was placed on an attached monitor', clamped.placed.length === 1,
    `failed=${JSON.stringify(clamped.failed)}`)
  if (clamped.placed.length === 1) {
    check('clamping was reported to the caller',
      clamped.placed[0].clamped === true || clamped.notes.length > 0,
      `clamped=${clamped.placed[0].clamped} notes=${clamped.notes.length}`)
  }

  // 3. A window that does not exist is reported, never silently dropped.
  const missing = await place([{
    title: 'DeskResume Smoke Test - This Window Does Not Exist 不存在',
    class: null, state: 'normal', x: 10, y: 10, w: 400, h: 300, monitor: null,
  }])
  check('unmatched title is reported as a failure',
    missing.placed.length === 0 && missing.failed.length === 1,
    `placed=${missing.placed.length} failed=${missing.failed.length}`)

  // Restore the target to its original geometry and state.
  await place([{
    title: target.title, class: target.class, state: restoreState,
    x: restoreRect.x, y: restoreRect.y, w: restoreRect.w, h: restoreRect.h,
    monitor: target.monitor,
  }])
  console.log('  (target window returned to its original position)')
}

// The snapshot this test captured must not have landed in the real store.
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
