/**
 * DeskResume — restore report persistence.
 *
 * A restore is the one operation in this plugin that changes the desktop, and it
 * was the only one that left no trace. After the first real reboot the user asked
 * "为什么 QQ 没回来" and there was no way to answer: the report existed only in
 * the tool output / HTTP response, and the in-memory copy was gone the moment the
 * page was refreshed. `.dr-state/` held nothing but a lock file that had been
 * cleaned up correctly, which proves the run finished and proves nothing else.
 *
 * So every restore now writes `data/restore-<timestamp>.json` before returning.
 * `describeRestoreReport()` renders a saved report in the same words the live
 * caller uses, which is what makes an old report useful rather than a raw dump.
 *
 * @module lib/reports.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPORT_PREFIX = 'restore-'
const REPORT_SUFFIX = '.json'

export function reportDir(rootDir) {
  return path.join(rootDir, 'data')
}

/**
 * Trim one plan entry down to what a previous session needs to explain itself.
 *
 * The full plan carries every window rectangle, which is ~48 KB of geometry that
 * is never the answer to "why did this not come back". Titles, the executable and
 * the replayed arguments are.
 */
function trimEntry(entry) {
  return {
    name: entry.name ?? null,
    exe: entry.exe ?? null,
    args: Array.isArray(entry.args) ? entry.args : [],
    windowCount: entry.windowCount ?? (entry.windows ?? []).length,
    titles: (entry.windows ?? []).map(w => w.title).filter(Boolean),
    inferredDocuments: entry.inferredDocuments ?? undefined,
    note: entry.note ?? undefined,
  }
}

/** Trim the whole plan: counts plus per-app detail, no geometry. */
export function trimPlan(plan) {
  return {
    snapshotFile: plan.snapshotFile ?? null,
    launch: (plan.launch ?? []).map(trimEntry),
    existing: (plan.existing ?? []).map(trimEntry),
    manual: (plan.manual ?? []).map(trimEntry),
    explorer: (plan.explorer ?? []).map(f => f.path),
    warnings: plan.warnings ?? [],
  }
}

function stamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/**
 * Write one restore report.
 *
 * Never throws: a restore that worked must not be reported as failed because the
 * report file could not be written. The caller gets `{ok:false}` and a reason
 * instead, which goes into the report's notes.
 *
 * @param {string} rootDir
 * @param {object} payload  { plan, report, snapshotFile, timings }
 * @param {object} [options]
 * @param {number} [options.keep]  How many reports to retain (0 = keep all).
 * @returns {{ok: boolean, file?: string, error?: string}}
 */
export function writeRestoreReport(rootDir, payload, options = {}) {
  const { keep = 50 } = options
  try {
    const dir = reportDir(rootDir)
    fs.mkdirSync(dir, { recursive: true })

    const now = new Date()
    const file = path.join(dir, `${REPORT_PREFIX}${stamp(now)}${REPORT_SUFFIX}`)
    const doc = {
      schemaVersion: 1,
      savedAt: now.toISOString(),
      ok: payload.report?.ok ?? false,
      host: {
        os: os.version?.() ?? null,
        user: os.userInfo().username,
        computer: os.hostname(),
      },
      snapshotFile: payload.snapshotFile ?? payload.plan?.snapshotFile ?? null,
      timings: payload.timings ?? null,
      plan: payload.plan ? trimPlan(payload.plan) : null,
      report: payload.report ?? null,
    }
    fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8')
    pruneReports(dir, keep)
    return { ok: true, file }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** Retention, newest-first by name (names sort chronologically). */
function pruneReports(dir, keep) {
  if (!keep || keep <= 0) return
  try {
    const files = fs.readdirSync(dir)
      .filter(n => n.startsWith(REPORT_PREFIX) && n.endsWith(REPORT_SUFFIX))
      .sort()
    for (const name of files.slice(0, Math.max(0, files.length - keep))) {
      try { fs.rmSync(path.join(dir, name), { force: true }) } catch { /* best effort */ }
    }
  } catch { /* retention is never fatal */ }
}

/** Saved reports, newest first, with the fields a list view needs. */
export function listRestoreReports(rootDir, { limit = 20 } = {}) {
  const dir = reportDir(rootDir)
  if (!fs.existsSync(dir)) return { dir, reports: [], broken: [] }

  const reports = []
  const broken = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(REPORT_PREFIX) || !name.endsWith(REPORT_SUFFIX)) continue
    const file = path.join(dir, name)
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      const report = doc.report ?? {}
      reports.push({
        file,
        name,
        savedAt: doc.savedAt ?? null,
        ok: doc.ok === true,
        snapshotFile: doc.snapshotFile ?? null,
        launched: (report.launched ?? []).length,
        placed: (report.placed ?? []).length,
        failed: (report.failed ?? []).length,
        pending: (report.pending ?? []).length,
        documents: (report.documents ?? []).length,
        sizeBytes: fs.statSync(file).size,
        mtimeMs: fs.statSync(file).mtimeMs,
      })
    } catch (error) {
      broken.push({ file, name, reason: String(error?.message ?? error) })
    }
  }
  reports.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { dir, reports: reports.slice(0, limit), broken }
}

/** Read one saved report, with its path confined to the report directory. */
export function readRestoreReport(rootDir, file) {
  const dir = path.resolve(reportDir(rootDir))
  const resolved = path.resolve(String(file))
  const inside = resolved.toLowerCase().startsWith(dir.toLowerCase() + path.sep)
  if (!inside) throw new Error(`refusing report outside ${dir}: ${file}`)
  return JSON.parse(fs.readFileSync(resolved, 'utf8'))
}
