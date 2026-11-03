/**
 * DeskResume — snapshot storage and restore planning.
 *
 * This module is pure Node (no DSH context, no Windows API): it reads the JSON
 * snapshots the collector writes, validates them, and turns a snapshot into a
 * restore plan. Keeping it dependency-free means the restore logic is testable
 * without booting DSH or touching a live desktop.
 *
 * Boundary this module encodes: a snapshot is *observations*, not promises.
 * `planRestore()` never claims it can recover unsaved document content, and it
 * flags every entry it cannot faithfully restore instead of silently dropping
 * it.
 *
 * @module lib/snapshot.js
 */

import fs from 'node:fs'
import path from 'node:path'

export const SNAPSHOT_SCHEMA_VERSION = 1

/** Reasons a snapshot can be taken, mirroring collector/collect.ps1. */
export const SNAPSHOT_REASONS = ['manual', 'interval', 'session-end', 'boot', 'pre-restore']

/**
 * Processes that are infrastructure rather than "things the user opened".
 * Restoring these is either pointless or harmful (it can fight the shell).
 */
const DEFAULT_EXCLUDES = [
  'explorer.exe',        // shell; its windows come back via the Explorer path list
  'dwm.exe',
  'sihost.exe',
  'taskhostw.exe',
  'runtimebroker.exe',
  'searchapp.exe',
  'searchhost.exe',
  'startmenuexperiencehost.exe',
  'shellexperiencehost.exe',
  'textinputhost.exe',
  'applicationframehost.exe',
  'systemsettings.exe',
  'lockapp.exe',
  'dsh.exe',
  'deskresume.exe',
]

/** Windows that belong to the collector or to transient UI, not the user's work. */
const DEFAULT_TITLE_EXCLUDES = [
  'program manager',
  'microsoft text input application',
  'windows input experience',
  'default ime',
]

export function defaultExcludes() {
  return { processes: [...DEFAULT_EXCLUDES], titles: [...DEFAULT_TITLE_EXCLUDES] }
}

/** Where snapshots live for a given project root. */
export function dataDir(rootDir) {
  return path.join(rootDir, 'data')
}

export function collectorPath(rootDir) {
  return path.join(rootDir, 'collector', 'collect.ps1')
}

/**
 * List snapshots newest-first, with the parsed header fields needed to pick one.
 * A file that fails to parse is reported rather than skipped silently.
 */
export function listSnapshots(rootDir) {
  const dir = dataDir(rootDir)
  if (!fs.existsSync(dir)) return { dir, snapshots: [], broken: [] }

  const snapshots = []
  const broken = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith('snapshot-') || !name.endsWith('.json')) continue
    const file = path.join(dir, name)
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      const stats = doc.stats ?? {}
      snapshots.push({
        file,
        name,
        capturedAt: doc.capturedAt ?? null,
        reason: doc.reason ?? 'unknown',
        windows: stats.windows ?? (doc.windows ?? []).length,
        explorer: stats.explorerWindows ?? (doc.explorer ?? []).length,
        withCommandLine: stats.withCommandLine ?? 0,
        sizeBytes: fs.statSync(file).size,
        mtimeMs: fs.statSync(file).mtimeMs,
      })
    } catch (error) {
      broken.push({ file, name, reason: String(error?.message ?? error) })
    }
  }
  snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { dir, snapshots, broken }
}

/**
 * Upgrades from an older schema version, applied in order until the document
 * reaches SNAPSHOT_SCHEMA_VERSION. Each entry takes a document at version N and
 * returns one at version N+1.
 *
 * Empty today (version 1 is the first), but the mechanism is what matters: a
 * snapshot is a long-lived artefact that outlives the code that wrote it, and
 * after a power cut the *only* copy of the user's session may be an old-format
 * file. Refusing to read it is the worst possible outcome, so version handling
 * exists before it is needed rather than after a user hits it.
 */
const MIGRATIONS = {
  // 1: doc => ({ ...doc, schemaVersion: 2 }),
}

/**
 * Bring a document up to the current schema version, or throw with an
 * actionable message when that is impossible (a file written by a *newer*
 * build cannot be safely downgraded).
 */
export function migrateSnapshot(doc, file = '(in memory)') {
  const from = doc.schemaVersion
  if (!Number.isInteger(from)) {
    throw new Error(`${file}: missing or non-integer schemaVersion (${JSON.stringify(from)})`)
  }
  if (from > SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `${file}: snapshot schemaVersion ${from} is newer than this build supports ` +
      `(${SNAPSHOT_SCHEMA_VERSION}); upgrade DeskResume instead of deleting the snapshot`,
    )
  }
  let current = doc
  for (let v = from; v < SNAPSHOT_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v]
    if (!step) {
      throw new Error(`${file}: no migration path from schemaVersion ${v} to ${v + 1}`)
    }
    current = step(current)
  }
  return current
}

/** Read and validate one snapshot, migrating an older format when possible. */
export function readSnapshot(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const parsed = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('snapshot is not an object')
  const doc = migrateSnapshot(parsed, file)
  if (!Array.isArray(doc.windows)) throw new Error('snapshot has no windows array')
  doc.explorer = Array.isArray(doc.explorer) ? doc.explorer : []
  doc.stats = doc.stats ?? {}
  return doc
}

/**
 * Pick the snapshot to restore: explicit file, or the newest matching `reason`.
 *
 * An explicit `file` is confined to the snapshot directory. Without that, any
 * caller able to reach the plugin (its HTTP API included) could point `restore`
 * at a file it wrote itself and have DeskResume launch whatever that file names —
 * turning a restore feature into arbitrary program execution. A snapshot is only
 * ever a file this project wrote into `data/`, so confining it costs nothing.
 */
export function pickSnapshot(rootDir, { file, reason } = {}) {
  if (file) {
    const dir = dataDir(rootDir)
    const resolved = path.resolve(String(file))
    const dirResolved = path.resolve(dir)
    const inside = resolved === dirResolved
      || resolved.toLowerCase().startsWith(dirResolved.toLowerCase() + path.sep)
    if (!inside) {
      throw new Error(
        `refusing snapshot outside the snapshot directory: ${file} ` +
        `(snapshots must live under ${dir})`,
      )
    }
    if (!fs.existsSync(resolved)) throw new Error(`snapshot not found: ${file}`)
    return resolved
  }
  const { snapshots } = listSnapshots(rootDir)
  if (snapshots.length === 0) throw new Error(`no snapshots in ${dataDir(rootDir)}`)
  if (reason) {
    const hit = snapshots.find(s => s.reason === reason)
    if (!hit) throw new Error(`no snapshot with reason "${reason}"`)
    return hit.file
  }
  // Prefer the pinned pre-shutdown capture when one exists: after a power cut
  // that is the state the user actually wants back.
  const preShutdown = snapshots.find(s => s.reason === 'session-end')
  return (preShutdown ?? snapshots[0]).file
}

/**
 * Collapse a snapshot's per-window rows into one entry per process, because
 * restoring is per-application (launch once, then place each of its windows).
 */
export function groupByProcess(doc, options = {}) {
  const excludes = options.excludes ?? defaultExcludes()
  const procEx = new Set(excludes.processes.map(s => s.toLowerCase()))
  const titleEx = excludes.titles.map(s => s.toLowerCase())

  const groups = new Map()
  const skipped = []

  for (const w of doc.windows) {
    const name = String(w.name ?? '').toLowerCase()
    const title = String(w.title ?? '')

    if (name && procEx.has(name)) {
      skipped.push({ title, pid: w.pid, reason: 'excluded-process', detail: name })
      continue
    }
    if (titleEx.some(t => title.toLowerCase().includes(t))) {
      skipped.push({ title, pid: w.pid, reason: 'excluded-title' })
      continue
    }
    if (!w.exe && !w.commandLine) {
      // Without an executable path there is nothing to launch.
      skipped.push({ title, pid: w.pid, reason: 'no-launch-info' })
      continue
    }

    const key = String(w.exe ?? w.name ?? w.pid).toLowerCase()
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        exe: w.exe ?? null,
        name: w.name ?? null,
        commandLine: w.commandLine ?? null,
        args: Array.isArray(w.args) ? w.args : [],
        cwd: w.cwd ?? null,
        windows: [],
      })
    }
    const g = groups.get(key)
    g.windows.push({
      hwnd: w.hwnd,
      title,
      state: w.state ?? 'normal',
      rect: w.rect ?? null,
      normalRect: w.normalRect ?? null,
      monitor: w.monitor ?? null,
      class: w.class ?? null,
    })
    // Keep the richest metadata seen for this process.
    if (!g.commandLine && w.commandLine) {
      g.commandLine = w.commandLine
      g.args = Array.isArray(w.args) ? w.args : []
    }
    if (!g.cwd && w.cwd) g.cwd = w.cwd
  }

  const apps = [...groups.values()]
  for (const app of apps) {
    app.windowCount = app.windows.length
    // A process that already declares its documents on the command line can be
    // relaunched with them; that is the highest-fidelity restore available.
    app.relaunchArgs = relaunchArgs(app)
  }
  apps.sort((a, b) => b.windowCount - a.windowCount)
  return { apps, skipped }
}

/** A replayable argument is a URL or an absolute path — nothing else. */
const URL_RE = /^(https?|ftp|file):\/\//i
const DRIVE_RE = /^[a-z]:[\\/]/i
const UNC_RE = /^\\\\[^\\]+\\/

/**
 * Normalise one raw command-line token.
 *
 * Command lines routinely carry stray whitespace inside a quoted argument
 * (`--parent-log-prefix=MM " -sw0x…"` yields the argv element `" -sw0x…"`).
 * That leading space is precisely what used to defeat the old `startsWith('-')`
 * check, so trimming is a correctness requirement here, not cosmetics.
 */
function normalizeArg(raw) {
  let s = String(raw).trim()
  // A quoted path can survive as one argv element with its quotes intact.
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim()
  return s
}

function looksReplayable(s) {
  return URL_RE.test(s) || DRIVE_RE.test(s) || UNC_RE.test(s)
}

/**
 * Build the argv for relaunching an app from its observed command line.
 *
 * **Whitelist, not blacklist.** An argument survives only if it looks like a
 * document path or URL; everything else is dropped by omission. This is
 * deliberate: the previous blacklist (`startsWith('-')`) was defeated three
 * different ways by real applications on this machine, and any blacklist can be
 * defeated by a switch shape nobody anticipated. Replaying an unknown switch is
 * the one thing this function must never do, so the default is to drop.
 *
 * Observed cases that motivated the whitelist (all from a real snapshot):
 *   WeChat.exe      " -sw0x…:1791977224185"   leading space bypassed the filter
 *   QQ.exe          /hosthwnd=… /memoryid=…   `/` switches were never filtered
 *   GameViewer.exe  source=explorer.exe, <guid>   key=value and bare GUID
 *   WPS Office      /prometheus /pdf <doc>    switches dropped, document kept
 *
 * Chromium/Electron children share one executable and are distinguishable only
 * by `--type=`; relaunching one alone is meaningless, so the whole app is
 * refused rather than filtered.
 */
export function relaunchArgs(app) {
  const raw = Array.isArray(app.args) ? app.args : []
  if (raw.length === 0) return []

  const args = raw.map(normalizeArg)

  const helperMarkers = [
    '--type=',                 // Chromium helper process
    '--user-data-dir=',        // points at a live profile
    '--remote-debugging-port=',
    '--crashpad-handler',
  ]
  if (args.some(a => helperMarkers.some(m => a.startsWith(m)))) return []

  const self = app.exe ? path.resolve(String(app.exe)).toLowerCase() : null

  return args.filter(a => {
    if (a === '') return false
    if (!looksReplayable(a)) return false
    // QQ and similar pass their own executable back as an argument; replaying
    // that is never something the user did.
    if (self) {
      try {
        if (path.resolve(a).toLowerCase() === self) return false
      } catch { /* not a path; already excluded by the shape check */ }
    }
    return true
  })
}

/**
 * Turn a snapshot into an executable restore plan.
 *
 * Every app lands in exactly one bucket so the caller can show the user what
 * will happen before anything is launched:
 *   launch   — we can start it and place its windows
 *   existing — already running; only reposition (never launch a second copy)
 *   manual   — needs the user (elevated, single-instance, or no launch info)
 */
export function planRestore(doc, options = {}) {
  const { apps, skipped } = groupByProcess(doc, options)
  const running = new Set(
    (options.runningProcesses ?? []).map(s => String(s).toLowerCase()),
  )
  const only = options.only && options.only.length > 0
    ? new Set(options.only.map(s => String(s).toLowerCase()))
    : null

  // `only` accepts either a process name ("code.exe") or a full exe path, which
  // is what a caller reading the plan back naturally has to hand.
  const isWanted = app => !only
    || only.has(app.key)
    || (app.name ? only.has(String(app.name).toLowerCase()) : false)

  const plan = { launch: [], existing: [], manual: [], skipped, explorer: [], warnings: [] }

  for (const app of apps) {
    if (!isWanted(app)) continue

    const entry = {
      key: app.key,
      name: app.name,
      exe: app.exe,
      commandLine: app.commandLine,
      cwd: app.cwd,
      args: app.relaunchArgs,
      windowCount: app.windowCount,
      windows: app.windows,
    }

    if (running.has(app.key) || (app.name && running.has(String(app.name).toLowerCase()))) {
      entry.note = '已在运行，只重新定位窗口，不会启动第二个实例'
      plan.existing.push(entry)
      continue
    }

    if (!app.exe) {
      entry.note = '没有可执行文件路径，无法自动启动'
      plan.manual.push(entry)
      continue
    }

    if (isSingleInstance(app)) {
      entry.note = '单实例应用：只能重新定位已打开的窗口，无法再开一个'
      plan.manual.push(entry)
      continue
    }

    plan.launch.push(entry)
  }

  // Explorer is handled separately: one window per saved folder.
  const seen = new Set()
  for (const e of doc.explorer ?? []) {
    const p = e.path
    if (!p || seen.has(p.toLowerCase())) continue
    seen.add(p.toLowerCase())
    plan.explorer.push({ path: p, url: e.url ?? null })
  }

  plan.warnings = restoreWarnings(doc, plan)
  return plan
}

/** Apps Windows will only ever allow one of, so "launch" would just focus them. */
function isSingleInstance(app) {
  const name = String(app.name ?? '').toLowerCase()
  const exe = String(app.exe ?? '').toLowerCase()
  // Only processes that survive DEFAULT_EXCLUDES can reach this check; listing
  // SystemSettings/ApplicationFrameHost here would be dead code, since they are
  // filtered out as infrastructure before the planner sees them.
  const singles = ['taskmgr.exe']
  return singles.includes(name) || singles.some(s => exe.includes(s))
}

/** Facts the user must know before trusting a restore. */
function restoreWarnings(doc, plan) {
  const warnings = []
  const stats = doc.stats ?? {}

  if (plan.launch.length + plan.existing.length + plan.manual.length === 0) {
    warnings.push('这个快照里没有可恢复的应用程序。')
  }
  if ((stats.withCommandLine ?? 0) < (stats.windows ?? 0)) {
    const missing = (stats.windows ?? 0) - (stats.withCommandLine ?? 0)
    warnings.push(`${missing} 个窗口没有读到命令行，这些程序只能恢复到「打开程序」而不是「打开具体文件」。`)
  }
  if (plan.manual.length > 0) {
    warnings.push(`${plan.manual.length} 个程序需要手动处理（提权运行、单实例或无启动信息）。`)
  }
  warnings.push('未保存的文档内容无法恢复：本工具只还原窗口，不还原内容。')
  return warnings
}

/** A short human summary of a snapshot, for list views and agent output. */
export function summarizeSnapshot(doc) {
  const { apps, skipped } = groupByProcess(doc)
  const stats = doc.stats ?? {}
  return {
    capturedAt: doc.capturedAt,
    reason: doc.reason,
    windows: (doc.windows ?? []).length,
    apps: apps.length,
    explorer: (doc.explorer ?? []).length,
    screens: stats.screens ?? (doc.host?.screens ?? []).length,
    skipped: skipped.length,
    topApps: apps.slice(0, 10).map(a => ({ name: a.name, windows: a.windowCount })),
  }
}
