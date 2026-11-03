/**
 * DeskResume — Host half.
 *
 * Contributes one agent tool (`deskresume`) and a same-origin JSON API the
 * Settings page reads. Snapshot capture lives in `collector/collect.ps1`; the
 * restore planner and executor live in `lib/`.
 *
 * Wiring notes:
 *   - `ctx.inject(['webServer'], ...)` rather than a one-shot `ctx.get`: plugins
 *     load before the browser half publishes the server, so reading it at apply
 *     time answers `undefined` and the routes never register.
 *   - This plugin never modifies the profile's package.json or cordis.patch.yml;
 *     the Plugin Manager owns those.
 *
 * Scope boundary, enforced rather than documented only: the collector is
 * read-only and the plugin never elevates. Windows of elevated processes cannot
 * be repositioned without UAC, so those are reported as `manual` instead.
 *
 * @module index.js
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  listSnapshots, readSnapshot, pickSnapshot, planRestore, summarizeSnapshot,
  dataDir, collectorPath, defaultExcludes,
} from './lib/snapshot.js'
import { loadConfig } from './lib/config.js'
import { runCollector } from './lib/collector.js'
import { executeRestore } from './lib/restore.js'
import { checkEnvironment, describeEnvironmentProblem, describeEnvironment } from './lib/environment.js'
import {
  titleHistoryFromFiles, buildRecentIndex, annotateInferredDocuments, plannedDocumentPaths,
} from './lib/documents.js'
import { loadRecentDocumentIndex } from './lib/recent-index.js'
import { listRestoreReports } from './lib/reports.js'

export const name = 'deskresume'

/** Only `tools` is required; the HTTP surface degrades away without a server. */
export const inject = ['tools']

const PKG_DIR = fileURLToPath(new URL('./', import.meta.url))
const API_PREFIX = '/api/deskresume'

/** The project root is this package's directory: collector/ and data/ live here. */
function rootDir() {
  return PKG_DIR
}

/** Snapshots are project-local so a snapshot never mixes two checkouts. */
function storeDir() {
  return dataDir(rootDir())
}

function ensureStore() {
  const dir = storeDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Names of processes currently running, for the "already open" check. */
async function runningProcessNames() {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const { stdout } = await run('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    const names = new Set()
    for (const line of String(stdout).split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)"/)
      if (m) names.add(m[1].toLowerCase())
    }
    return names
  } catch {
    // Without tasklist the planner simply cannot detect running apps; it will
    // plan a launch for each, which is the safe direction (the executor still
    // refuses to double-launch anything it can see).
    return new Set()
  }
}

function renderSnapshotList(list) {
  if (list.snapshots.length === 0) {
    return [
      '还没有任何快照。',
      '',
      `运行 collector（deskresume action="capture"）来创建第一个快照。`,
    ].join('\n')
  }
  const lines = [`快照 ${list.snapshots.length} 个（目录 ${list.dir}）`, '']
  for (const s of list.snapshots.slice(0, 20)) {
    lines.push(`  ${s.name}`)
    lines.push(`    时间 ${s.capturedAt ?? '(未知)'} · 原因 ${s.reason} · 窗口 ${s.windows} · 资源管理器 ${s.explorer}`)
  }
  if (list.broken.length > 0) {
    lines.push('')
    lines.push(`有 ${list.broken.length} 个快照文件无法解析：`)
    for (const b of list.broken) lines.push(`  ${b.name} — ${b.reason}`)
  }
  return lines.join('\n')
}

function renderSummary(summary) {
  const lines = [
    `快照摘要 · ${summary.capturedAt ?? '(未知时间)'} · 原因 ${summary.reason ?? 'unknown'}`,
    '',
    `窗口 ${summary.windows} · 应用 ${summary.apps} · 资源管理器 ${summary.explorer} · 显示器 ${summary.screens}`,
  ]
  if (summary.topApps.length > 0) {
    lines.push('')
    lines.push('占用窗口最多的应用：')
    for (const a of summary.topApps) lines.push(`  ${a.name} — ${a.windows} 个窗口`)
  }
  if (summary.skipped > 0) lines.push(`\n已跳过 ${summary.skipped} 个窗口（系统进程/无标题/无启动信息）。`)
  return lines.join('\n')
}

function renderPlan(plan) {
  const lines = []
  lines.push(`恢复方案：启动 ${plan.launch.length} 个 · 只重定位 ${plan.existing.length} 个 · 需手动 ${plan.manual.length} 个 · 文件夹 ${plan.explorer.length} 个`)

  const inferred = []
  for (const e of [...(plan.launch ?? []), ...(plan.existing ?? [])]) {
    for (const d of e.inferredDocuments ?? []) inferred.push({ app: e.name ?? e.key, doc: d })
  }
  if (inferred.length > 0) {
    lines.push(`另外会按快照历史推测打开 ${inferred.length} 个文档（多标签窗口只能这样恢复）。`)
  }

  if (plan.launch.length > 0) {
    lines.push('')
    lines.push('将启动：')
    for (const e of plan.launch) {
      const docs = e.args.length > 0 ? `  ← ${e.args.slice(0, 3).join(' ')}` : ''
      lines.push(`  ${e.name} (${e.windowCount} 窗口)${docs}`)
    }
  }
  if (plan.existing.length > 0) {
    lines.push('')
    lines.push('已在运行（只重定位）：')
    for (const e of plan.existing) {
      const docs = e.args?.length > 0 ? `  ← ${e.args.slice(0, 3).join(' ')}` : ''
      lines.push(`  ${e.name} (${e.windowCount} 窗口)${docs}`)
    }
  }
  if (inferred.length > 0) {
    lines.push('')
    lines.push('推测打开的文档：')
    for (const { app, doc } of inferred.slice(0, 20)) {
      lines.push(`  ${app}  ← ${doc.path}${doc.seen > 1 ? `（历史出现 ${doc.seen} 次）` : ''}`)
    }
    if (inferred.length > 20) lines.push(`  … 另有 ${inferred.length - 20} 个`)
  }
  if (plan.manual.length > 0) {
    lines.push('')
    lines.push('需要手动处理：')
    for (const e of plan.manual) lines.push(`  ${e.name} — ${e.note}`)
  }
  if (plan.explorer.length > 0) {
    lines.push('')
    lines.push('将重新打开的文件夹：')
    for (const f of plan.explorer.slice(0, 15)) lines.push(`  ${f.path}`)
    if (plan.explorer.length > 15) lines.push(`  … 另有 ${plan.explorer.length - 15} 个`)
  }
  if (plan.warnings.length > 0) {
    lines.push('')
    lines.push('注意：')
    for (const w of plan.warnings) lines.push(`  - ${w}`)
  }
  return lines.join('\n')
}

function renderRestore(report) {
  const lines = []
  if (report.locked) {
    lines.push('恢复被拒绝：已有一个恢复正在进行，未启动任何程序。')
    lines.push(`  ${report.failed?.[0]?.error ?? ''}`)
    lines.push('  如确认要强制执行，请加 force=true。')
    return lines.join('\n')
  }
  lines.push(
    `恢复完成：启动 ${report.launched.length} · 重开文件夹 ${report.reopened.length} · ` +
    `定位 ${report.placed.length} · 打开文档 ${report.documents.length} · ` +
    `失败 ${report.failed.length} · 待登录 ${report.pending.length}`,
  )
  if (report.launched.length > 0) {
    lines.push('')
    lines.push('已启动：')
    for (const l of report.launched) lines.push(`  ${l.name} (pid ${l.pid})`)
  }
  if (report.documents.length > 0) {
    lines.push('')
    lines.push(`已按历史推测打开 ${report.documents.length} 个文档：`)
    for (const d of report.documents.slice(0, 20)) lines.push(`  ${d.app}  ← ${d.path}`)
    if (report.documents.length > 20) lines.push(`  … 另有 ${report.documents.length - 20} 个`)
  }
  if (report.placed.length > 0) {
    const clamped = report.placed.filter(p => p.clamped).length
    const fuzzy = report.placed.filter(p => p.matchedTitle && p.matchedTitle !== p.title).length
    lines.push('')
    lines.push(`已定位 ${report.placed.length} 个窗口${clamped > 0 ? `（其中 ${clamped} 个因显示器变化被移到最近显示器）` : ''}${fuzzy > 0 ? `（${fuzzy} 个按标题前缀匹配）` : ''}。`)
  }
  if (report.pending.length > 0) {
    lines.push('')
    lines.push('待登录（不是失败，登录后窗口才会出现）：')
    for (const p of report.pending) lines.push(`  ${p.name} — ${p.title ?? '(窗口)'}：${p.error}`)
  }
  if (report.failed.length > 0) {
    lines.push('')
    lines.push('失败项：')
    for (const f of report.failed) {
      lines.push(`  ${f.name ?? f.title ?? '(未知)'} [${f.stage}] — ${f.error}`)
      if (Array.isArray(f.candidates) && f.candidates.length > 0) {
        lines.push(`    当时存在相似窗口：${f.candidates.slice(0, 3).join(' | ')}`)
      }
    }
  }
  if (report.documentsFailed.length > 0) {
    lines.push('')
    lines.push('文档打开失败：')
    for (const f of report.documentsFailed) lines.push(`  ${f.app} ← ${f.path} — ${f.error}`)
  }
  if (report.notes.length > 0) {
    lines.push('')
    for (const n of report.notes) lines.push(`  - ${n}`)
  }
  if (report.reportFile) {
    lines.push('')
    lines.push(`完整报告：${report.reportFile}`)
  }
  return lines.join('\n')
}

function renderReports(list) {
  if (list.reports.length === 0) {
    return [
      '还没有恢复报告。',
      '',
      '每次执行恢复都会在 data/ 下留一份 restore-<时间>.json，用来事后回答“为什么某个窗口没回来”。',
    ].join('\n')
  }
  const lines = [`恢复报告 ${list.reports.length} 份（目录 ${list.dir}）`, '']
  for (const r of list.reports) {
    lines.push(`  ${r.name}`)
    lines.push(
      `    ${r.savedAt ?? '(未知时间)'} · ${r.ok ? '全部完成' : '有失败项'} · ` +
      `启动 ${r.launched} · 定位 ${r.placed} · 打开文档 ${r.documents} · 待登录 ${r.pending} · 失败 ${r.failed}`,
    )
    if (r.snapshotFile) lines.push(`    来源快照 ${r.snapshotFile}`)
  }
  if (list.broken.length > 0) {
    lines.push('')
    lines.push(`有 ${list.broken.length} 份报告无法解析：`)
    for (const b of list.broken) lines.push(`  ${b.name} — ${b.reason}`)
  }
  return lines.join('\n')
}

export function apply(ctx, config) {
  const log = ctx.logger?.('deskresume') ?? ctx.logger ?? console

  /**
   * Configuration comes from config/deskresume.json (+ an optional local
   * override), with the plugin's own `config` block as the highest priority.
   * Reloaded per call so a user editing the file does not need to restart DSH.
   */
  function currentConfig() {
    const { config: loaded, problems } = loadConfig(rootDir(), config ?? {})
    for (const p of problems) log.warn?.(`deskresume: ${p}`)
    return loaded
  }

  /** Extra exclusions from config are merged into the built-in defaults. */
  function excludesFrom(cfg) {
    const base = defaultExcludes()
    return {
      processes: [...base.processes, ...cfg.extraExcludedProcesses],
      titles: [...base.titles, ...cfg.extraExcludedTitles],
    }
  }

  /** Timing knobs for the executor, all user-tunable via config. */
  function restoreTiming(cfg) {
    return {
      launchDelayMs: cfg.launchDelayMs,
      heavyDelayMs: cfg.heavyDelayMs,
      settleMs: cfg.settleMs,
      placeRetryMs: cfg.placeRetryMs,
      keepReports: cfg.keepReports,
    }
  }

  /**
   * Fill in the documents a tabbed app was showing.
   *
   * Deferred to here rather than baked into `planRestore()` because it needs two
   * resources outside the pure planner: the snapshot history on disk and a scan
   * of the user's recent files (a PowerShell run, cached for 15 min). Any failure
   * on either side leaves the plan exactly as it was — this is an enhancement,
   * never a precondition.
   */
  async function inferDocuments(plan, cfg) {
    try {
      const { snapshots } = listSnapshots(rootDir())
      const history = titleHistoryFromFiles(
        snapshots.map(s => s.file),
        readSnapshot,
        { withinMs: cfg.inferDocumentsHours * 3600 * 1000, onProblem: m => log.warn?.(`deskresume: ${m}`) },
      )
      const recent = await loadRecentDocumentIndex(rootDir())
      if (!recent.ok) log.warn?.(`deskresume: 文档索引不可用 — ${recent.error}`)

      const index = buildRecentIndex(recent.doc)
      const added = annotateInferredDocuments(plan, {
        history,
        recentIndex: index,
        apps: cfg.inferDocumentApps,
        limit: cfg.inferDocumentsLimit,
        alreadyPlanned: new Set(plannedDocumentPaths(plan)),
      })
      if (added.total > 0) {
        plan.inferredTotal = added.total
        plan.warnings.push(
          `另有 ${added.total} 个文档是按快照历史推测出来的（多标签窗口只暴露当前标签），` +
          '执行恢复时会一并打开；可在 config 里设 inferDocuments=false 关闭。',
        )
      }
      return added
    } catch (error) {
      log.warn?.(`deskresume: 推测文档失败 — ${error?.message ?? error}`)
      return { total: 0, apps: [] }
    }
  }

  /** Capture one snapshot. Shared by the tool and the HTTP surface. */
  async function capture(reason = 'manual', terminalCwd = null) {
    const env = checkEnvironment()
    if (!env.ok) {
      return {
        ok: false,
        error: describeEnvironmentProblem(env),
        environment: env,
      }
    }
    ensureStore()
    const cfg = currentConfig()
    const result = await runCollector({
      rootDir: rootDir(),
      reason,
      terminalCwd: terminalCwd === null ? cfg.terminalCwd : terminalCwd,
      keep: cfg.keepSnapshots,
      timeoutMs: cfg.captureTimeoutMs,
    })
    if (!result.ok) {
      log.warn?.(`deskresume: capture failed — ${result.error}`)
      return result
    }
    return result
  }

  /** Build a plan for a snapshot without touching the desktop. */
  async function buildPlan({ file, reason, only } = {}) {
    const cfg = currentConfig()
    const target = pickSnapshot(rootDir(), { file, reason })
    const doc = readSnapshot(target)
    const running = await runningProcessNames()
    const plan = planRestore(doc, {
      runningProcesses: [...running],
      only,
      excludes: excludesFrom(cfg),
    })
    plan.snapshotFile = target
    if (cfg.inferDocuments) await inferDocuments(plan, cfg)
    return { file: target, doc, plan }
  }

  /* ─────────────────────────── agent tool ─────────────────────────── */
  ctx.tools.register({
    name: 'deskresume',
    description:
      'Snapshot and restore the Windows desktop session (open apps, their documents, folders and ' +
      'window positions) across a restart or power loss. action "capture" records a read-only ' +
      'snapshot of what is open now. action "list" shows saved snapshots. action "inspect" summarizes ' +
      'one snapshot. action "plan" computes a restore plan without launching anything. action ' +
      '"restore" executes a plan: it launches apps that are not already running, opens the extra ' +
      'documents a tabbed app was showing, reopens saved folders, and moves windows back to their ' +
      'saved monitors in several passes (some apps only create windows after signing in). action ' +
      '"reports" lists saved restore reports. Snapshots are observations only — unsaved document ' +
      'content cannot be recovered, elevated windows cannot be repositioned, single-instance apps ' +
      'are only re-focused, and windows of apps that require login appear only after the user signs ' +
      'in. Always run "plan" before "restore".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['capture', 'list', 'inspect', 'plan', 'restore', 'reports'],
          description:
            'capture = take a snapshot now; list = show saved snapshots; inspect = summarize one; ' +
            'plan = dry run of a restore; restore = perform the restore; reports = saved restore reports.',
        },
        reason: {
          type: 'string',
          enum: ['manual', 'interval', 'session-end', 'boot', 'pre-restore'],
          description: 'For capture: why the snapshot is taken. For plan/restore: which snapshot to pick.',
        },
        file: {
          type: 'string',
          description: 'For inspect/plan/restore: an explicit snapshot file path. Overrides reason.',
        },
        only: {
          type: 'array',
          items: { type: 'string' },
          description: 'For plan/restore: restrict to these process names or exe paths.',
        },
        terminalCwd: {
          type: 'boolean',
          description: 'For capture: also read terminal working directories via each shell process PEB. Defaults to the config value.',
        },
        launch: {
          type: 'boolean',
          description: 'For restore: actually launch apps. Default true. Set false to only reposition windows.',
        },
        place: {
          type: 'boolean',
          description: 'For restore: actually move windows. Default true. Set false to only launch apps.',
        },
        force: {
          type: 'boolean',
          description:
            'For restore: run even if another restore holds the lock. Default false — a ' +
            'concurrent restore is refused so apps are not launched twice.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'action', 'text'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          text: { type: 'string' },
          summary: { type: 'object', additionalProperties: true, properties: {} },
          plan: { type: 'object', additionalProperties: true, properties: {} },
          report: { type: 'object', additionalProperties: true, properties: {} },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const action = String(args.action ?? 'list')

      if (action === 'capture') {
        const result = await capture(
          typeof args.reason === 'string' ? args.reason : 'manual',
          args.terminalCwd === true,
        )
        if (!result.ok) {
          return { ok: false, action, text: `采集失败：${result.error}` }
        }
        const stats = result.stats ?? {}
        return {
          ok: true,
          action,
          summary: stats,
          text: [
            `快照已保存：${result.outFile}`,
            `窗口 ${stats.windows} · 进程 ${stats.distinctProcesses} · 命令行可读 ${stats.withCommandLine} · 资源管理器 ${stats.explorerWindows} · 显示器 ${stats.screens}`,
          ].join('\n'),
        }
      }

      if (action === 'list') {
        const list = listSnapshots(rootDir())
        return { ok: true, action, text: renderSnapshotList(list), summary: { count: list.snapshots.length } }
      }

      if (action === 'inspect') {
        const file = pickSnapshot(rootDir(), { file: args.file, reason: args.reason })
        const doc = readSnapshot(file)
        const summary = summarizeSnapshot(doc)
        return { ok: true, action, text: renderSummary(summary), summary }
      }

      if (action === 'plan') {
        const { plan } = await buildPlan({ file: args.file, reason: args.reason, only: args.only })
        return { ok: true, action, text: renderPlan(plan), plan }
      }

      if (action === 'restore') {
        const env = checkEnvironment()
        if (!env.ok) {
          return { ok: false, action, text: `无法恢复：\n${describeEnvironmentProblem(env)}` }
        }
        const { plan } = await buildPlan({ file: args.file, reason: args.reason, only: args.only })
        if (args.launch === false && args.place === false) {
          return { ok: false, action, text: 'launch 和 place 都为 false，没有任何事情可做。', plan }
        }
        const report = await executeRestore(plan, {
          rootDir: rootDir(),
          launch: args.launch !== false,
          place: args.place !== false,
          force: args.force === true,
          ...restoreTiming(currentConfig()),
        })
        return { ok: report.ok, action, text: renderRestore(report), plan, report }
      }

      if (action === 'reports') {
        const list = listRestoreReports(rootDir())
        return { ok: true, action, text: renderReports(list), summary: { count: list.reports.length } }
      }

      throw new Error(`unknown action "${action}"`)
    },
  })

  /* ─────────────────────────── HTTP surface ─────────────────────────── */

  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.replace(/^\/api\/deskresume/, '').replace(/\/+$/, '') || '/'
      const method = String(req.method ?? 'GET').toUpperCase()
      const send = (status, payload) => {
        const body = JSON.stringify(payload)
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      }

      /*
       * This API can launch programs and move windows, so it must not be
       * reachable by anything other than the DSH page on this machine.
       *
       * The DSH web server does NOT gate plugin routes: a request with no
       * credentials, a forged `Host`, a cross-site `Origin` and
       * `Sec-Fetch-Site: cross-site` all reach this handler and get 200. That was
       * verified against a live server, so the checks below are load-bearing, not
       * belt-and-braces. Without them a web page the user merely visits could
       * POST to /capture, or to /restore, which starts applications.
       *
       * Two independent conditions, both required:
       *   1. the Host must be a loopback name — a browser cannot forge this, and
       *      it blocks DNS-rebinding, where a hostile domain resolves to
       *      127.0.0.1 and then sends the request with its own Host.
       *   2. a cross-site request must be refused outright. Simple requests
       *      (text/plain, no preflight) are exactly how a CSRF would arrive.
       */
      const hostHeader = String(req.headers?.host ?? '')
      const hostName = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
      const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])
      const isLoopbackHost = loopbackHosts.has(hostName) || hostName.endsWith('.localhost')

      const secFetchSite = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase()
      const origin = String(req.headers?.origin ?? '')
      let originHost = ''
      if (origin) {
        try { originHost = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase() } catch { originHost = '(unparseable)' }
      }
      const originIsLoopback = origin === '' || loopbackHosts.has(originHost) || originHost.endsWith('.localhost')

      if (!isLoopbackHost || secFetchSite === 'cross-site' || !originIsLoopback) {
        log.warn?.(
          `deskresume: refused ${method} ${route} — host=${hostHeader || '(none)'} ` +
          `origin=${origin || '(none)'} sec-fetch-site=${secFetchSite || '(none)'}`,
        )
        return send(403, {
          error: 'refused: this API only answers requests from the local DSH page',
          host: hostHeader || null,
          origin: origin || null,
        })
      }

      try {
        if (method === 'GET' && route === '/snapshots') {
          return send(200, listSnapshots(rootDir()))
        }
        if (method === 'GET' && route === '/snapshot') {
          const file = url.searchParams.get('file')
          if (!file) return send(400, { error: 'file is required' })
          const doc = readSnapshot(file)
          return send(200, { file, summary: summarizeSnapshot(doc), doc })
        }
        if (method === 'GET' && route === '/plan') {
          const only = url.searchParams.getAll('only').filter(Boolean)
          const { file, plan } = await buildPlan({
            file: url.searchParams.get('file'),
            reason: url.searchParams.get('reason'),
            only: only.length > 0 ? only : undefined,
          })
          return send(200, { file, plan })
        }
        if (method === 'POST' && route === '/capture') {
          const body = await readJson(req)
          const result = await capture(body.reason ?? 'manual', body.terminalCwd === true)
          return send(result.ok ? 200 : 500, result)
        }
        if (method === 'POST' && route === '/restore') {
          const body = await readJson(req)
          const { file, plan } = await buildPlan({ file: body.file, reason: body.reason, only: body.only })
          if (body.dryRun === true) return send(200, { ok: true, dryRun: true, file, plan })
          const report = await executeRestore(plan, {
            rootDir: rootDir(),
            launch: body.launch !== false,
            place: body.place !== false,
            force: body.force === true,
            ...restoreTiming(currentConfig()),
          })
          return send(report.ok ? 200 : 500, { file, plan, report })
        }
        if (method === 'GET' && route === '/environment') {
          const env = checkEnvironment()
          return send(200, {
            ok: env.ok,
            platform: env.platform,
            facts: env.facts,
            problems: env.problems,
            summary: describeEnvironment(env),
          })
        }
        if (method === 'GET' && route === '/reports') {
          return send(200, listRestoreReports(rootDir()))
        }
        if (method === 'GET' && route === '/config') {
          const cfg = currentConfig()
          const env = checkEnvironment()
          return send(200, {
            rootDir: rootDir(),
            dataDir: storeDir(),
            collector: collectorPath(rootDir()),
            keepSnapshots: cfg.keepSnapshots,
            intervalSeconds: cfg.intervalSeconds,
            terminalCwd: cfg.terminalCwd,
            placeRetryMs: cfg.placeRetryMs,
            keepReports: cfg.keepReports,
            inferDocuments: cfg.inferDocuments,
            inferDocumentsHours: cfg.inferDocumentsHours,
            inferDocumentsLimit: cfg.inferDocumentsLimit,
            schemaVersion: 1,
            environment: {
              ok: env.ok,
              summary: describeEnvironment(env),
              problems: env.problems,
            },
          })
        }
        return send(404, { error: `no route ${method} ${route}` })
      } catch (error) {
        log.warn?.(`deskresume: ${error?.message ?? error}`)
        return send(500, { error: String(error?.message ?? error) })
      }
    }
    scoped.effect(
      () => server.register({ kind: 'prefix', path: API_PREFIX, handler }),
      'deskresume: api routes',
    )
    log.info?.(`deskresume: API mounted at ${API_PREFIX}`)
  })

  ctx.effect(() => () => { /* nothing persistent to release */ }, 'deskresume: lifetime')
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try { resolve(JSON.parse(text)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

export { planRestore, summarizeSnapshot, listSnapshots, runCollector, executeRestore }
export default { name, inject, apply }
