/**
 * DeskResume — restore executor.
 *
 * Takes the plan produced by `lib/snapshot.js` and carries it out:
 *   1. launch each app that is not already running, with its observed documents
 *   2. reopen the inferred documents of tabbed apps (see `lib/documents.js`)
 *   3. reopen the saved Explorer folders
 *   4. place every restored window back on its saved monitor, in rounds
 *   5. save the report to `data/restore-*.json`
 *
 * Rules enforced here rather than left to the caller:
 *
 *   - **Never launch a second copy of something already running.** Placement is
 *     attempted first; a launch only happens when the process is genuinely absent.
 *   - **Never fight the user.** Placement is clamped to an attached monitor, and
 *     a window that cannot be matched is reported, not silently skipped.
 *   - **Placement is not a single shot.** One 3 s wait works for a warm app and
 *     fails for anything that signs in first: QQ and WeChat create their windows
 *     only after login, so the first pass legitimately finds nothing. Re-tries
 *     cost nothing when the first pass placed everything.
 *   - **Never report a login screen as a lost window.** When a sign-in app still
 *     has no matching window after every round, that is "waiting for you to log
 *     in", not a placement failure — and it is reported as such.
 *
 * Elevation is out of scope by design: windows of elevated processes cannot be
 * repositioned by a non-elevated process, and DeskResume does not request UAC.
 *
 * @module lib/restore.js
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { POWERSHELL } from './collector.js'
import { writeRestoreReport } from './reports.js'

/** Launch one application, detached so it outlives the DSH process. */
function launchApp(entry) {
  return new Promise(resolve => {
    const args = [entry.exe, ...(entry.args ?? [])]
    const options = {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }
    // Only pass cwd when it still exists; a stale path makes spawn throw.
    if (entry.cwd && fs.existsSync(entry.cwd)) options.cwd = entry.cwd

    try {
      const child = spawn(args[0], args.slice(1), options)
      child.on('error', error => resolve({ ok: false, error: String(error?.message ?? error) }))
      child.unref()
      // spawn() resolving only means the process was created, not that its
      // window exists yet — placement waits for that separately.
      resolve({ ok: true, pid: child.pid })
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) })
    }
  })
}

/** Open a folder in Explorer (one window per saved path). */
function openFolder(folderPath) {
  return new Promise(resolve => {
    try {
      const child = spawn('explorer.exe', [folderPath], { detached: true, stdio: 'ignore' })
      child.on('error', error => resolve({ ok: false, error: String(error?.message ?? error) }))
      child.unref()
      resolve({ ok: true })
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) })
    }
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * A restore is a long, stateful sequence (launch, wait, reposition). Two of them
 * overlapping — a double-clicked button, a retried HTTP request, the GUI and the
 * agent tool at once — would launch duplicate apps and fight over window
 * positions. The lock is a file so it also holds across processes (plugin and
 * scheduled task), and it carries a timestamp so a crashed run cannot wedge the
 * feature forever.
 */
const LOCK_STALE_MS = 10 * 60 * 1000

function lockPath(rootDir) {
  return path.join(rootDir, '.dr-state', 'restore.lock')
}

function acquireLock(rootDir) {
  const file = lockPath(rootDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    // wx = fail if it exists, which makes acquisition atomic.
    const fd = fs.openSync(file, 'wx')
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    fs.closeSync(fd)
    return { ok: true, file }
  } catch (error) {
    if (error?.code !== 'EEXIST') return { ok: false, file, error: String(error?.message ?? error) }
  }

  // Someone holds it. Only take it over if the holder is provably gone or the
  // lock is older than any plausible restore.
  let holder = null
  try { holder = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* unreadable: treat as stale */ }
  const startedMs = holder?.startedAt ? Date.parse(holder.startedAt) : NaN
  const age = Number.isFinite(startedMs) ? Date.now() - startedMs : Infinity
  const holderAlive = Number.isInteger(holder?.pid) ? isProcessAlive(holder.pid) : false

  if (age < LOCK_STALE_MS && holderAlive) {
    return { ok: false, file, error: `another restore is already running (pid ${holder?.pid ?? 'unknown'}, started ${holder?.startedAt ?? 'unknown'})` }
  }

  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')
    return { ok: true, file, tookOver: true }
  } catch (error) {
    return { ok: false, file, error: String(error?.message ?? error) }
  }
}

function releaseLock(handle) {
  if (!handle?.ok) return
  try { fs.rmSync(handle.file, { force: true }) } catch { /* best effort */ }
}

/** `process.kill(pid, 0)` throws ESRCH when the process is gone. */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'   // exists but owned by someone else
  }
}

/**
 * Execute a restore plan.
 *
 * @param {object} plan                     From planRestore().
 * @param {object} options
 * @param {string} options.rootDir          Project root (for the placement script).
 * @param {number} [options.launchDelayMs]  Gap between launches. Default 700.
 * @param {number} [options.heavyDelayMs]   Extra gap after known-heavy apps.
 * @param {number} [options.settleMs]       Wait before the first placement round.
 * @param {number[]} [options.placeRetryMs] Waits before each extra placement round.
 * @param {number} [options.keepReports]    How many saved reports to retain.
 * @param {boolean} [options.launch]        Actually launch apps. Default true.
 * @param {boolean} [options.place]         Actually reposition windows. Default true.
 * @param {boolean} [options.force]         Run even if another restore holds the lock.
 * @returns {Promise<object>} a per-item report, plus `reportFile`
 */
export async function executeRestore(plan, options = {}) {
  const {
    rootDir,
    launchDelayMs = 700,
    heavyDelayMs = 2000,
    settleMs = 3000,
    placeRetryMs = [12000, 30000],
    keepReports = 50,
    launch = true,
    place = true,
    force = false,
  } = options

  const report = {
    launched: [],
    reopened: [],
    placed: [],
    failed: [],
    pending: [],
    documents: [],
    documentsFailed: [],
    notes: [...(plan.warnings ?? [])],
  }

  // Refuse to run concurrently rather than launching everything twice.
  const lock = force ? { ok: true, file: null } : acquireLock(rootDir)
  if (!lock.ok) {
    report.failed.push({ stage: 'lock', error: lock.error })
    report.ok = false
    report.locked = true
    return report
  }
  if (lock.tookOver) {
    report.notes.push('检测到上一次恢复残留的锁（进程已退出），已接管继续执行。')
  }

  try {
    const result = await runRestore(plan, {
      rootDir, launchDelayMs, heavyDelayMs, settleMs, placeRetryMs, launch, place, report,
    })
    saveReport(rootDir, plan, result, { keep: keepReports, settleMs, placeRetryMs, launchDelayMs, heavyDelayMs })
    return result
  } finally {
    releaseLock(lock)
  }
}

/**
 * Persist the run so it can still be explained tomorrow.
 *
 * The first real reboot produced the question "为什么 QQ 没回来" with nothing on
 * disk to answer it — the report lived only in the tool output that scrolled away.
 * A failed write is a note, not a failure: the restore already happened.
 */
function saveReport(rootDir, plan, report, { keep, ...timings }) {
  const written = writeRestoreReport(
    rootDir,
    { plan, report, snapshotFile: plan.snapshotFile ?? null, timings },
    { keep },
  )
  if (written.ok) {
    report.reportFile = written.file
    report.notes.push(`恢复报告已保存：${written.file}`)
  } else {
    report.notes.push(`恢复报告保存失败（不影响本次恢复）：${written.error}`)
  }
}

async function runRestore(plan, opts) {
  const {
    rootDir, launchDelayMs, heavyDelayMs, settleMs, placeRetryMs, launch, place, report,
  } = opts

  // ── 1. apps already running: place only, never relaunch ──────────────────
  for (const entry of plan.existing ?? []) {
    report.notes.push(`${entry.name ?? entry.key}：已在运行，跳过启动。`)
  }

  // ── 2. launch what is missing ────────────────────────────────────────────
  if (launch) {
    for (const entry of plan.launch ?? []) {
      const result = await launchApp(entry)
      if (result.ok) {
        report.launched.push({ name: entry.name, exe: entry.exe, args: entry.args, pid: result.pid })
        const heavy = /chrome|msedge|firefox|code|idea|studio|photoshop|wps|excel|word/i.test(String(entry.name ?? ''))
        await sleep(heavy ? heavyDelayMs : launchDelayMs)
      } else {
        report.failed.push({ name: entry.name ?? entry.key, stage: 'launch', error: result.error })
      }
    }

    for (const folder of plan.explorer ?? []) {
      const result = await openFolder(folder.path)
      if (result.ok) report.reopened.push(folder.path)
      else report.failed.push({ name: folder.path, stage: 'explorer', error: result.error })
    }
  }

  // ── 3. documents the tabbed apps were showing ────────────────────────────
  // Only on a real restore: a "move windows only" pass must not reopen tabs the
  // user has since closed, and it is the pass the user is told to run after
  // logging in to QQ/WeChat.
  if (launch) await reopenInferredDocuments(plan, { report, delayMs: launchDelayMs })

  // ── 4. place windows, in rounds ──────────────────────────────────────────
  if (place) {
    const placements = collectPlacements(plan)
    if (placements.length === 0) {
      report.notes.push('没有可定位的窗口。')
    } else {
      await placeInRounds(placements, { rootDir, settleMs, placeRetryMs, report })
    }
  }

  report.ok = report.failed.length === 0 && report.documentsFailed.length === 0
  return report
}

/**
 * Reopen the documents a tabbed app was showing, one launch per document.
 *
 * Each document is passed as its own invocation (`wps.exe <path>`) because that
 * is exactly what the user does by double-clicking a file: the app hands it to
 * the running instance and opens a tab. Passing several paths in one command line
 * is not portable across these applications, and a single launch with no arguments
 * is what we already do.
 */
async function reopenInferredDocuments(plan, { report, delayMs }) {
  const jobs = collectDocumentJobs(plan)
  if (jobs.length === 0) return

  for (const { entry, doc } of jobs) {
    const result = await launchApp({ exe: entry.exe, args: [doc.path], cwd: entry.cwd })
    if (result.ok) {
      report.documents.push({
        app: entry.name ?? entry.key,
        path: doc.path,
        name: doc.name,
        inferred: true,
        pid: result.pid,
      })
      await sleep(delayMs)
    } else {
      report.documentsFailed.push({
        app: entry.name ?? entry.key, path: doc.path, stage: 'document', error: result.error,
      })
    }
  }
}

/**
 * Which documents to open, as flat jobs.
 *
 * Only `launch` and `existing`: a `manual` entry has no executable to hand the
 * file to. Exported for tests, which assert the bucket rules without spawning.
 */
export function collectDocumentJobs(plan) {
  const jobs = []
  for (const bucket of ['launch', 'existing']) {
    for (const entry of plan[bucket] ?? []) {
      if (!entry.exe) continue
      for (const doc of entry.inferredDocuments ?? []) jobs.push({ entry, doc })
    }
  }
  return jobs
}

/** Apps whose windows only exist after the user signs in. */
const LOGIN_GATED = [/^qq\.exe$/i, /^tim\.exe$/i, /^weixin\.exe$/i, /^wechat\.exe$/i]

export function isLoginGated(entry) {
  const name = String(entry?.name ?? '')
  const exe = String(entry?.exe ?? '')
  return LOGIN_GATED.some(re => re.test(name) || re.test(path.basename(exe)))
}

/**
 * Run placement, then re-run it for whatever is still unmatched.
 *
 * Each round waits first, then places only the outstanding requests, so a window
 * that appeared late is placed exactly once and an early success is never
 * disturbed. `place.ps1` echoes the request id back, which is what makes this
 * bookkeeping reliable: titles are matched by prefix, so they are not unique.
 */
export async function placeInRounds(placements, { rootDir, settleMs, placeRetryMs, report, apply = applyPlacements }) {
  const waits = [settleMs, ...(Array.isArray(placeRetryMs) ? placeRetryMs : [])]
  let remaining = placements
  let lastFailures = []

  for (let round = 0; round < waits.length && remaining.length > 0; round++) {
    await sleep(waits[round])
    const result = await apply(remaining, { rootDir })
    report.placed.push(...result.placed)
    report.notes.push(...result.notes)
    lastFailures = result.failed ?? []

    const placedIds = new Set(result.placed.map(p => p.id))
    const before = remaining.length
    remaining = remaining.filter(r => !placedIds.has(r.id))

    if (round > 0 && remaining.length > 0) {
      report.notes.push(
        `定位第 ${round + 1} 轮：还剩 ${remaining.length} 个窗口未出现（等待 ${waits[round]}ms 后重试）。`,
      )
    }
    if (before === remaining.length && remaining.length > 0) {
      // Nothing moved this round; the remaining windows may simply not exist.
      continue
    }
  }

  if (remaining.length === 0) return

  // Anything still unmatched after the final round: is it waiting for a login, or
  // is it genuinely gone? Conflating the two was the reason a QQ restore looked
  // like a hard failure.
  const candidatesByTitle = new Map()
  for (const f of lastFailures) {
    if (f?.title && Array.isArray(f.candidates)) candidatesByTitle.set(f.title, f.candidates)
  }

  const pendingApps = new Set()
  for (const req of remaining) {
    if (isLoginGated({ name: req.app, exe: req.exe })) {
      pendingApps.add(req.app ?? req.exe ?? '(未知)')
      report.pending.push({
        name: req.app ?? req.exe,
        title: req.title,
        reason: 'login',
        error: '程序还没完成登录，登录成功后窗口才会出现',
      })
      continue
    }
    const failure = {
      stage: 'place',
      title: req.title,
      name: req.app ?? undefined,
      error: `窗口未出现（共 ${waits.length} 轮定位）`,
    }
    const candidates = candidatesByTitle.get(req.title)
    if (candidates?.length) failure.candidates = candidates
    report.failed.push(failure)
  }

  for (const app of pendingApps) {
    report.notes.push(
      `${app}：登录还没有完成，所以它的聊天窗口暂时无法定位。` +
      '登录完成后，再执行一次「只重排窗口」即可把窗口摆回原位（不会重复启动程序）。',
    )
  }
}

/** Flatten the plan's per-window geometry into placement requests. */
function collectPlacements(plan) {
  const out = []
  let id = 0
  for (const bucket of ['launch', 'existing', 'manual']) {
    for (const entry of plan[bucket] ?? []) {
      for (const w of entry.windows ?? []) {
        const rect = w.state === 'maximized' || w.state === 'minimized'
          ? (w.normalRect ?? w.rect)
          : (w.rect ?? w.normalRect)
        if (!rect || rect.w <= 0 || rect.h <= 0) continue
        out.push({
          // The id is what round bookkeeping matches on; place.ps1 echoes it back.
          id: id++,
          app: entry.name ?? entry.key ?? null,
          exe: entry.exe ?? null,
          title: w.title,
          class: w.class ?? null,
          state: w.state ?? 'normal',
          x: rect.x, y: rect.y, w: rect.w, h: rect.h,
          monitor: w.monitor ?? null,
        })
      }
    }
  }
  return out
}

/**
 * Decode a chunk of PowerShell's stderr.
 *
 * place.ps1 now declares `[Console]::OutputEncoding = UTF8`, so its stderr is
 * UTF-8 and a plain decode is correct. This helper exists because that guarantee
 * is a property of the *script*, not of PowerShell: a future script, a syntax
 * error that aborts before the encoding line runs, or a different host can still
 * emit the OEM code page (GBK/936 on this machine). Decoding those bytes as UTF-8
 * silently yields replacement characters, which is precisely how a readable
 * "使用…时发生异常" turned into the unreadable garbage a user reported.
 *
 * So: prefer UTF-8, and fall back to the local ANSI code page only when the bytes
 * are not valid UTF-8. The result is a best-effort diagnostic either way, never a
 * reason to fail the restore.
 */
function decodePsOutput(chunk) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return buf.toString('utf8')
    }
  }
}

/**
 * Hand the placement list to PowerShell, which does the actual SetWindowPos.
 * Matching is by window title + class because handles are not stable across a
 * reboot; a title that no longer exists is reported as unmatched.
 *
 * The requests and the result travel as UTF-8 files rather than stdio:
 * PowerShell 5.1 decodes piped stdin with the OEM code page, which would mangle
 * non-ASCII window titles and break matching.
 */
function applyPlacements(placements, { rootDir }) {
  return new Promise(resolve => {
    const script = path.join(rootDir, 'collector', 'place.ps1')
    if (!fs.existsSync(script)) {
      return resolve({ placed: [], failed: [], notes: [`placement script missing: ${script}`] })
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskresume-place-'))
    const inFile = path.join(tmpDir, 'requests.json')
    const outFile = path.join(tmpDir, 'result.json')
    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ } }

    try {
      fs.writeFileSync(inFile, JSON.stringify(placements), 'utf8')
    } catch (error) {
      cleanup()
      return resolve({ placed: [], failed: [{ stage: 'place', error: String(error?.message ?? error) }], notes: [] })
    }

    const child = spawn(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Json', inFile, '-Out', outFile,
    ], { windowsHide: true })

    let stderr = ''
    child.stdout.on('data', () => { /* progress only; the result is the file */ })
    child.stderr.on('data', c => { stderr += decodePsOutput(c) })
    child.on('error', error => {
      cleanup()
      resolve({
        placed: [], failed: [{ stage: 'place', error: String(error?.message ?? error) }], notes: [],
      })
    })
    child.on('close', code => {
      try {
        if (code !== 0) {
          return resolve({
            placed: [], notes: [],
            failed: [{ stage: 'place', error: `place.ps1 exited ${code}: ${stderr.trim().slice(0, 300)}` }],
          })
        }
        if (!fs.existsSync(outFile)) {
          return resolve({
            placed: [], notes: [],
            failed: [{ stage: 'place', error: 'place.ps1 produced no result file' }],
          })
        }
        const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'))
        resolve({
          placed: parsed.placed ?? [],
          failed: parsed.failed ?? [],
          notes: parsed.notes ?? [],
        })
      } catch (error) {
        resolve({ placed: [], failed: [{ stage: 'place', error: `unreadable place.ps1 result: ${error?.message ?? error}` }], notes: [] })
      } finally {
        cleanup()
      }
    })
  })
}
