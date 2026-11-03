/**
 * DeskResume — configuration layer.
 *
 * Unattended capture has policy the user must be able to change without editing
 * code: how often to snapshot, how many to keep, which apps to ignore. Those
 * values were previously hardcoded in `index.js` or only settable per-call,
 * which does not work for a scheduled task that has no caller to pass flags.
 *
 * Resolution order (first wins):
 *   1. explicit overrides passed by the caller
 *   2. `<root>/config/deskresume.local.json`   (user's own file, gitignored)
 *   3. `<root>/config/deskresume.json`         (shipped defaults)
 *   4. built-in DEFAULTS below
 *
 * A malformed or unreadable file is reported, never fatal: falling back to the
 * defaults is always better than refusing to snapshot.
 *
 * @module lib/config.js
 */

import fs from 'node:fs'
import path from 'node:path'

/** Built-in defaults; also the schema reference for config/deskresume.json. */
export const DEFAULTS = {
  /** Seconds between unattended interval snapshots (scheduled task). */
  intervalSeconds: 600,
  /**
   * How many snapshots to retain in data/. The collector deletes the oldest
   * beyond this count after every capture.
   *
   * `intervalSeconds` and `keepSnapshots` together decide how far back the
   * history reaches, and that is the number to think about:
   *
   *     coverage = keepSnapshots * intervalSeconds
   *
   * 144 x 600 s = 86400 s = 24 hours. (Note the units: 120 s x 30 would be
   * 3600 s = 1 hour, not 10 — an earlier comment here got that wrong by 10x and
   * described the tradeoff backwards.)
   *
   * Disk use is bounded by the count, not the interval: measured at ~44 KB per
   * snapshot, 144 snapshots is ~6.2 MB regardless of how often they are taken.
   * So a longer interval buys more history at the same disk cost, and raising
   * this count is what extends coverage further.
   */
  keepSnapshots: 144,
  /** Capture terminal working directories (opens each shell with PROCESS_VM_READ). */
  terminalCwd: false,
  /** Extra process names to treat as infrastructure, on top of the built-ins. */
  extraExcludedProcesses: [],
  /** Extra window-title fragments to ignore. */
  extraExcludedTitles: [],
  /** Milliseconds before an unattended capture is killed. */
  captureTimeoutMs: 60000,
  /** Milliseconds between app launches during a restore. */
  launchDelayMs: 700,
  /** Extra settle time after a known-heavy app is launched. */
  heavyDelayMs: 2000,
  /** Milliseconds to wait for windows to appear before placing them. */
  settleMs: 3000,
  /**
   * Extra placement passes, each value being the wait before that pass.
   *
   * A single 3 s wait is enough for an app that is already installed and warm,
   * but not for anything that has to finish signing in first: QQ and WeChat
   * create their windows only after login completes, so the one-shot pass found
   * nothing and reported every saved window as "not found". Re-trying costs
   * nothing when the first pass succeeded — the rounds are skipped as soon as
   * everything has been placed.
   */
  placeRetryMs: [12000, 30000],
  /** How many restore reports to keep in data/restore-*.json (0 = keep all). */
  keepReports: 50,
  /**
   * Infer extra documents from snapshot history (see lib/documents.js).
   *
   * An app that keeps every document in one tabbed window — WPS Office does —
   * exposes only the active tab's title, and its process command line froze at
   * the first document it was launched with. So a restore reopened exactly one
   * file. The history over retained snapshots is the only evidence available
   * about the other tabs, hence an inference rather than a reading.
   */
  inferDocuments: true,
  /** How far back to look for those titles. */
  inferDocumentsHours: 24,
  /** Cap per application, so a long history cannot open dozens of windows. */
  inferDocumentsLimit: 8,
  /**
   * Processes eligible for inferred documents. Deliberately a list of document
   * editors: for a browser the window title is a page title, not a file name, so
   * "opening the document" would mean asking Chrome to open a local file it was
   * never showing. Replace this list to add another tabbed editor.
   */
  inferDocumentApps: [
    'wps.exe', 'et.exe', 'wpp.exe', 'wpspdf.exe',
    'winword.exe', 'excel.exe', 'powerpnt.exe',
    'notepad.exe', 'notepad++.exe', 'typora.exe',
    'acrobat.exe', 'acrord32.exe', 'foxitreader.exe', 'sumatrapdf.exe',
  ],
}

export function configDir(rootDir) {
  return path.join(rootDir, 'config')
}

export function shippedConfigPath(rootDir) {
  return path.join(configDir(rootDir), 'deskresume.json')
}

export function localConfigPath(rootDir) {
  return path.join(configDir(rootDir), 'deskresume.local.json')
}

function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return { value: null, error: null }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { value: null, error: `${file}: expected a JSON object` }
    }
    return { value: parsed, error: null }
  } catch (error) {
    return { value: null, error: `${file}: ${error?.message ?? error}` }
  }
}

/** Coerce one value, falling back to the default when it is unusable. */
function num(value, fallback, { min = 0 } = {}) {
  const n = Number(value)
  return Number.isFinite(n) && n >= min ? n : fallback
}

function strList(value, fallback) {
  if (!Array.isArray(value)) return fallback
  return value.filter(v => typeof v === 'string' && v.trim() !== '').map(v => v.trim())
}

/** A list of non-negative numbers, filtered — used for retry schedules. */
function numList(value, fallback, { min = 0, max = 600000 } = {}) {
  if (!Array.isArray(value)) return fallback
  const out = value
    .map(v => Number(v))
    .filter(n => Number.isFinite(n) && n >= min && n <= max)
  return out
}

/**
 * Load the effective configuration.
 *
 * @param {string} rootDir  Project root (holds config/).
 * @param {object} [overrides]  Highest-priority values (e.g. from a tool call).
 * @returns {{config: object, sources: string[], problems: string[]}}
 */
export function loadConfig(rootDir, overrides = {}) {
  const problems = []
  const sources = []

  const shipped = readJsonIfPresent(shippedConfigPath(rootDir))
  if (shipped.error) problems.push(shipped.error)
  const local = readJsonIfPresent(localConfigPath(rootDir))
  if (local.error) problems.push(local.error)

  if (shipped.value) sources.push(shippedConfigPath(rootDir))
  if (local.value) sources.push(localConfigPath(rootDir))

  // Later sources win over earlier ones; overrides win over everything.
  const merged = { ...shipped.value, ...local.value }
  const pick = key => (overrides[key] !== undefined ? overrides[key] : merged[key])

  const config = {
    intervalSeconds: num(pick('intervalSeconds'), DEFAULTS.intervalSeconds, { min: 15 }),
    keepSnapshots: num(pick('keepSnapshots'), DEFAULTS.keepSnapshots, { min: 1 }),
    terminalCwd: pick('terminalCwd') === true,
    extraExcludedProcesses: strList(pick('extraExcludedProcesses'), DEFAULTS.extraExcludedProcesses),
    extraExcludedTitles: strList(pick('extraExcludedTitles'), DEFAULTS.extraExcludedTitles),
    captureTimeoutMs: num(pick('captureTimeoutMs'), DEFAULTS.captureTimeoutMs, { min: 1000 }),
    launchDelayMs: num(pick('launchDelayMs'), DEFAULTS.launchDelayMs, { min: 0 }),
    heavyDelayMs: num(pick('heavyDelayMs'), DEFAULTS.heavyDelayMs, { min: 0 }),
    settleMs: num(pick('settleMs'), DEFAULTS.settleMs, { min: 0 }),
    placeRetryMs: numList(pick('placeRetryMs'), DEFAULTS.placeRetryMs),
    keepReports: num(pick('keepReports'), DEFAULTS.keepReports, { min: 0 }),
    inferDocuments: pick('inferDocuments') !== false,
    inferDocumentsHours: num(pick('inferDocumentsHours'), DEFAULTS.inferDocumentsHours, { min: 1 }),
    inferDocumentsLimit: num(pick('inferDocumentsLimit'), DEFAULTS.inferDocumentsLimit, { min: 0 }),
    inferDocumentApps: strList(pick('inferDocumentApps'), DEFAULTS.inferDocumentApps),
  }

  return { config, sources, problems }
}
