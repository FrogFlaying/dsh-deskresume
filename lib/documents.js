/**
 * DeskResume — inferred documents for tabbed applications.
 *
 * The problem this module exists for, stated plainly:
 *
 *   WPS Office keeps every open document as a tab inside ONE top-level window.
 *   `user32.EnumWindows` therefore reports one window for five documents, the
 *   window title carries only the active tab, and the process command line froze
 *   at the document it was first launched with. A restore could replay exactly
 *   that one file and nothing else — which is what the user saw after the reboot.
 *
 * Nothing can read another process's tab list. What IS available:
 *
 *   1. history — the interval snapshots already record that window's title every
 *      `intervalSeconds`, so across the retained 24 h a tab that was visited at
 *      least once leaves its file name behind;
 *   2. resolution — those titles are file names, and Windows keeps a Recent
 *      shortcut for every document a user opens, plus WPS records its own list
 *      with full paths.
 *
 * Combining them turns "one document" into "the documents this app was showing
 * recently". It is an inference, not an observation: a document that was opened
 * and closed inside one snapshot interval leaves no trace, and a document opened
 * and closed hours ago is still in the history. So the result is always labelled
 * as inferred, capped per app, and can be switched off in config.
 *
 * @module lib/documents.js
 */

import fs from 'node:fs'

/**
 * File extensions a window title can plausibly end with.
 *
 * Deliberately narrow: this list is what separates "the title names a document"
 * from "the title is a page name / project name / error message". A browser tab
 * titled "百度智能云文档" must never be mistaken for a file.
 */
const DOC_EXT_RE = /\.(xlsx|xlsm|xls|docx|docm|doc|pptx|pptm|ppt|pdf|csv|txt|md|markdown|rtf|wps|et|dps|ofd|htm|html)$/i

/** Strip decorations an application adds around the real file name. */
function cleanTitle(title) {
  let s = String(title ?? '').trim()
  if (!s) return ''
  // Trailing markers are not used here, only leading ones: the "*" that marks
  // unsaved changes ("*06_2_储备项目接口文档.md - Typora") and the "[只读]" that
  // WPS puts in front of a read-only document.
  s = s.replace(/^[*•]\s*/, '')
  for (let i = 0; i < 3 && /^\[[^\]]{1,16}\]\s*/.test(s); i++) {
    s = s.replace(/^\[[^\]]{1,16}\]\s*/, '')
  }
  return s.trim()
}

function baseName(p) {
  const normalized = String(p).replace(/[\\/]+$/, '')
  const idx = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

/**
 * Extract a document reference from a window title.
 *
 * Real titles this has to survive (all from this machine's snapshots):
 *   "网络策略申请记录表.xlsx - WPS Office"
 *   "[只读]HTTPS卸载配置信息-数字化营销支持凭条.xlsx - WPS Office"
 *   "940个支付名词大全-8.4万字-陈天宇支付学院出品.pdf - WPS Office"
 *   "*06_2_储备项目接口文档.md - Typora"
 *   "网络策略申请记录表.xlsx - WPS 表格"
 *   "C:\Users\<你>\Desktop\plan - Notepad++"      → null (no extension)
 *   "WPS Office - WPS Office"                      → null (no document)
 *
 * @returns {{name: string, path: string|null}|null}
 */
export function documentNameFromTitle(title) {
  const cleaned = cleanTitle(title)
  if (!cleaned) return null

  // Split on the " - <AppName>" separator applications append. Hyphens inside a
  // file name are normally unspaced ("940个支付名词大全-8.4万字"), which is what
  // makes this split safe.
  for (const raw of cleaned.split(/\s+-\s+/)) {
    const candidate = raw.trim()
    if (!candidate || !DOC_EXT_RE.test(candidate)) continue

    const isAbsolute = /^[a-z]:[\\/]/i.test(candidate) || candidate.startsWith('\\\\')
    if (isAbsolute) return { name: baseName(candidate), path: candidate }
    // Anything else that still contains a separator is a fragment of a path, not
    // a file name this module can resolve.
    if (/[\\/]/.test(candidate)) continue
    return { name: candidate, path: null }
  }
  return null
}

/**
 * Build per-process title history from parsed snapshots.
 *
 * @param {Array<object>} docs            Parsed snapshots (any order).
 * @param {object} [options]
 * @param {number} [options.withinMs]     Ignore snapshots older than this.
 * @param {number} [options.now]          Clock injection for tests.
 * @returns {Map<string, {exe: string|null, name: string|null, titles: Map<string, {title: string, count: number, lastSeen: number}>}>}
 */
export function buildTitleHistory(docs, options = {}) {
  const { withinMs = Infinity, now = Date.now() } = options
  const cutoff = Number.isFinite(withinMs) ? now - withinMs : -Infinity

  const history = new Map()
  for (const doc of docs ?? []) {
    const capturedAt = Date.parse(String(doc?.capturedAt ?? ''))
    if (Number.isFinite(cutoff) && Number.isFinite(capturedAt) && capturedAt < cutoff) continue

    for (const w of doc?.windows ?? []) {
      const exe = w.exe ?? null
      const name = w.name ?? null
      const key = String(exe ?? name ?? '').toLowerCase()
      const title = String(w.title ?? '').trim()
      if (!key || !title) continue

      if (!history.has(key)) history.set(key, { exe, name, titles: new Map() })
      const group = history.get(key)
      const titleKey = title.toLowerCase()
      const prev = group.titles.get(titleKey)
      if (prev) {
        prev.count++
        prev.lastSeen = Math.max(prev.lastSeen, Number.isFinite(capturedAt) ? capturedAt : now)
      } else {
        group.titles.set(titleKey, {
          title,
          count: 1,
          lastSeen: Number.isFinite(capturedAt) ? capturedAt : now,
        })
      }
    }
  }
  return history
}

/**
 * Read the retained snapshots and build the history.
 *
 * Files are filtered by mtime before parsing, so a 144-snapshot retention costs
 * one `stat` per file rather than a full parse.
 *
 * @param {string[]} files    Snapshot paths (from listSnapshots()).
 * @param {object} readSnapshot  Parser injection (lib/snapshot.js).
 */
export function titleHistoryFromFiles(files, readSnapshot, options = {}) {
  const { withinMs = Infinity, now = Date.now(), onProblem } = options
  const cutoff = Number.isFinite(withinMs) ? now - withinMs : -Infinity
  const docs = []
  for (const file of files ?? []) {
    try {
      const st = fs.statSync(file)
      if (st.mtimeMs < cutoff) continue
      docs.push(readSnapshot(file))
    } catch (error) {
      onProblem?.(`${file}: ${error?.message ?? error}`)
    }
  }
  return buildTitleHistory(docs, { withinMs, now })
}

/**
 * Turn the raw index from `collector/recent-docs.ps1` into lookups.
 *
 * @param {object} raw  { entries: [{name, path, modifiedMs, source}] }
 * @returns {{byName: Map<string, Array<{path: string, modifiedMs: number, source: string}>>, size: number}}
 */
export function buildRecentIndex(raw) {
  const byName = new Map()
  const entries = Array.isArray(raw?.entries) ? raw.entries : []

  for (const e of entries) {
    const filePath = String(e?.path ?? '')
    if (!filePath) continue
    const name = String(e.name ?? baseName(filePath)).toLowerCase()
    if (!name) continue
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push({
      path: filePath,
      modifiedMs: Number(e.modifiedMs) || 0,
      source: String(e.source ?? 'unknown'),
    })
  }
  for (const list of byName.values()) list.sort((a, b) => b.modifiedMs - a.modifiedMs)
  return { byName, size: entries.length }
}

/** Resolve one title-derived name to a path that exists right now. */
export function resolveDocumentPath(ref, recentIndex) {
  if (!ref) return null

  if (ref.path) {
    try {
      return fs.statSync(ref.path).isFile() ? ref.path : null
    } catch { return null }
  }

  const hits = recentIndex?.byName?.get(String(ref.name).toLowerCase())
  if (!hits || hits.length === 0) return null
  // The index was built from files that existed when it was written; re-check,
  // because a document can be moved or deleted between the two.
  for (const hit of hits) {
    try {
      if (fs.statSync(hit.path).isFile()) return hit.path
    } catch { /* try the next candidate */ }
  }
  return null
}

/**
 * Attach inferred documents to a restore plan, in place.
 *
 * Only apps the caller named in `apps` are considered — browsers are excluded
 * because their titles are page names, and an app that reports every document as
 * its own window already restores them faithfully from the command line.
 *
 * @param {object} plan                       From planRestore().
 * @param {object} options
 * @param {Map} options.history               From buildTitleHistory().
 * @param {object} options.recentIndex        From buildRecentIndex().
 * @param {string[]} [options.apps]           Eligible process names (lowercase).
 * @param {number} [options.limit]            Max documents per app.
 * @param {Set<string>} [options.alreadyPlanned] Absolute paths already restored.
 * @returns {{total: number, apps: Array<{name: string, documents: Array<object>}>}}
 */
export function annotateInferredDocuments(plan, options = {}) {
  const {
    history, recentIndex, apps = [], limit = 8, alreadyPlanned = new Set(),
  } = options

  const allowed = new Set(apps.map(a => String(a).toLowerCase()))
  const used = new Set([...alreadyPlanned].map(p => String(p).toLowerCase()))
  const added = []

  for (const bucket of ['launch', 'existing']) {
    for (const entry of plan[bucket] ?? []) {
      const keys = [
        String(entry.key ?? '').toLowerCase(),
        String(entry.name ?? '').toLowerCase(),
        entry.exe ? baseName(String(entry.exe)).toLowerCase() : '',
      ].filter(Boolean)

      const eligible = keys.find(k => allowed.has(k))
      if (!eligible) continue

      const group = history?.get(keys[0]) ?? history?.get(eligible)
      if (!group) continue

      const documents = []
      // Newest title first: the tab the user was actually on is the one most
      // likely to still be wanted, and the cap must keep the best candidates.
      const titles = [...group.titles.values()].sort((a, b) => b.lastSeen - a.lastSeen)
      for (const rec of titles) {
        if (documents.length >= limit) break
        const ref = documentNameFromTitle(rec.title)
        if (!ref) continue
        const resolved = resolveDocumentPath(ref, recentIndex)
        if (!resolved) continue
        const lower = resolved.toLowerCase()
        if (used.has(lower)) continue
        used.add(lower)
        documents.push({ name: ref.name, path: resolved, title: rec.title, seen: rec.count })
      }

      if (documents.length > 0) {
        entry.inferredDocuments = documents
        added.push({ name: entry.name ?? entry.key, documents })
      }
    }
  }

  return { total: added.reduce((n, a) => n + a.documents.length, 0), apps: added }
}

/** Absolute document paths a plan already covers explicitly. */
export function plannedDocumentPaths(plan) {
  const out = []
  for (const bucket of ['launch', 'existing', 'manual']) {
    for (const entry of plan[bucket] ?? []) {
      for (const arg of entry.args ?? []) {
        if (/^[a-z]:[\\/]/i.test(String(arg)) || String(arg).startsWith('\\\\')) out.push(String(arg))
      }
    }
  }
  return out
}

/** Compatibility re-export for callers that only need the file name. */
export function documentFileName(title) {
  return documentNameFromTitle(title)?.name ?? null
}

export { DOC_EXT_RE, cleanTitle, baseName }
