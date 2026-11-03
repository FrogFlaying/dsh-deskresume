/**
 * DeskResume — browser half.
 *
 * Contributes one Settings section ("桌面续开") that lists snapshots, previews a
 * restore plan, and executes it. All data comes from the plugin's own same-origin
 * `/api/deskresume/*` routes, which the Host half mounts on the server that
 * serves this page.
 *
 * Hand-written ModuleLoader bundle: no build step, and the only dependency is the
 * `react` the shell already provides. Every colour is a theme token so the page
 * survives a light/dark switch.
 *
 * @module client.js
 */

window.__ModuleLoader__.load({
  id: 'dsh-deskresume',
  factory: require => {
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    const API = '/api/deskresume'

    const T = {
      zh: {
        nav: '桌面续开',
        title: '桌面续开',
        subtitle: '重启或断电后，把关机前打开的程序、文件和文件夹一键恢复回来。',
        capture: '立即快照',
        capturing: '快照中…',
        refresh: '刷新',
        loading: '加载中…',
        noSnapshots: '还没有快照。先点「立即快照」记录当前桌面。',
        snapshots: '快照',
        capturedAt: '时间',
        reason: '原因',
        windows: '窗口',
        explorer: '文件夹',
        plan: '预览恢复方案',
        planning: '计算中…',
        restore: '一键恢复',
        restoring: '恢复中…',
        restoreAll: '恢复全部',
        launchOnly: '只启动程序',
        placeOnly: '只重排窗口',
        willLaunch: '将启动',
        willMove: '已在运行（只重定位）',
        willManual: '需要手动处理',
        willFolders: '将重新打开的文件夹',
        inferredDocs: '推测打开的文档',
        inferredHint: '这些文档来自快照历史（多标签窗口只暴露当前标签），恢复时会一并打开。',
        pendingLogin: '待登录',
        openedDocs: '已打开文档',
        reportSaved: '完整报告',
        envWarning: '当前环境不支持',
        warnings: '注意',
        result: '恢复结果',
        launched: '已启动',
        placed: '已定位窗口',
        failed: '失败',
        notes: '说明',
        selectSnapshot: '选择快照',
        dryRun: '这是预览，尚未改动桌面。',
        confirm: '确定要恢复吗？会启动程序并移动窗口。',
        reasonManual: '手动',
        reasonInterval: '定时',
        reasonSessionEnd: '关机前',
        reasonBoot: '开机',
        reasonPreRestore: '恢复前',
        boundary: '边界：未保存的文档内容无法恢复；提权运行的窗口无法被重定位；单实例应用只会被切到前台。',
        loadFailed: '无法读取快照列表',
        restoreFailed: '恢复未完成',
        captureFailed: '快照失败',
        planFailed: '无法计算恢复方案',
        retry: '重试',
        // Display helpers: the raw values are machine-facing (ISO timestamps,
        // snapshot file names) and look out of place in a Chinese UI.
        agoJustNow: '刚刚',
        agoMinutes: '分钟前',
        agoHours: '小时前',
        agoDays: '天前',
        selectHint: '点一个快照查看可恢复的内容。',
        loadingSnapshots: '正在读取快照…',
      },
      en: {
        nav: 'DeskResume',
        title: 'DeskResume',
        subtitle: 'Reopen the apps, files and folders you had open before a restart or power loss.',
        capture: 'Snapshot now',
        capturing: 'Capturing…',
        refresh: 'Refresh',
        loading: 'Loading…',
        noSnapshots: 'No snapshots yet. Take one to record the current desktop.',
        snapshots: 'Snapshots',
        capturedAt: 'Captured',
        reason: 'Reason',
        windows: 'Windows',
        explorer: 'Folders',
        plan: 'Preview restore',
        planning: 'Planning…',
        restore: 'Restore',
        restoring: 'Restoring…',
        restoreAll: 'Restore all',
        launchOnly: 'Launch apps only',
        placeOnly: 'Move windows only',
        willLaunch: 'Will launch',
        willMove: 'Already running (reposition only)',
        willManual: 'Needs manual handling',
        willFolders: 'Folders to reopen',
        inferredDocs: 'Documents inferred from history',
        inferredHint: 'Inferred from snapshot history — a tabbed window only exposes its active tab. These are opened during a restore.',
        pendingLogin: 'Waiting for login',
        openedDocs: 'Documents opened',
        reportSaved: 'Full report',
        envWarning: 'Unsupported environment',
        warnings: 'Notes',
        result: 'Restore result',
        launched: 'Launched',
        placed: 'Windows placed',
        failed: 'Failed',
        notes: 'Details',
        selectSnapshot: 'Select a snapshot',
        dryRun: 'This is a preview; nothing on the desktop changed.',
        confirm: 'Restore now? This will launch apps and move windows.',
        reasonManual: 'manual',
        reasonInterval: 'interval',
        reasonSessionEnd: 'pre-shutdown',
        reasonBoot: 'boot',
        reasonPreRestore: 'pre-restore',
        boundary: 'Limits: unsaved document content cannot be recovered; elevated windows cannot be repositioned; single-instance apps are only brought to the front.',
        loadFailed: 'Could not load snapshots',
        restoreFailed: 'Restore did not finish',
        captureFailed: 'Snapshot failed',
        planFailed: 'Could not compute the restore plan',
        retry: 'Retry',
        agoJustNow: 'just now',
        agoMinutes: 'min ago',
        agoHours: 'h ago',
        agoDays: 'd ago',
        selectHint: 'Pick a snapshot to see what can be restored.',
        loadingSnapshots: 'Reading snapshots…',
      },
    }

    /**
     * Which language to render.
     *
     * This used to try a single accessor (`ctx.locale.current()`) and fall back to
     * English. That accessor does not exist on this shell, so the lookup always
     * failed and a Chinese user got an English page — while the neighbouring
     * plugin, which reads `ctx.get('locale').get()`, rendered Chinese correctly.
     *
     * Two fixes: try every accessor the shell actually exposes, and fall back to
     * Chinese rather than English. The fallback direction matters because this
     * project is Chinese-first (its docs, agent output and the user's own UI are
     * Chinese), so a failed lookup must not silently switch languages.
     */
    function localeTag(ctx) {
      const accessors = [
        () => ctx?.get?.('locale')?.get?.(),
        () => ctx?.get?.('locale')?.locale,
        () => ctx?.locale?.get?.(),
        () => ctx?.locale?.current?.(),
        () => ctx?.locale?.tag,
        () => (typeof document !== 'undefined' ? document.documentElement?.lang : null),
        () => (typeof navigator !== 'undefined' ? navigator.language : null),
      ]
      for (const read of accessors) {
        try {
          const value = read()
          if (typeof value === 'string' && value.trim() !== '') {
            return value.trim().toLowerCase().startsWith('en') ? 'en' : 'zh'
          }
        } catch { /* try the next accessor */ }
      }
      return 'zh'
    }

    const S = {
      wrap: { padding: '4px 2px 24px', maxWidth: 900 },
      h1: { fontSize: 18, fontWeight: 600, margin: '0 0 4px' },
      sub: { fontSize: 13, opacity: 0.7, margin: '0 0 16px', lineHeight: 1.6 },
      row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 },
      btn: primary => ({
        padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
        border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
        background: primary ? 'var(--dsh-accent, #4a7dff)' : 'transparent',
        color: primary ? '#fff' : 'inherit',
        opacity: 1,
      }),
      card: {
        border: '1px solid var(--dsh-border, rgba(128,128,128,.25))',
        borderRadius: 8, padding: 12, marginBottom: 8, cursor: 'pointer',
      },
      cardActive: {
        border: '1px solid var(--dsh-accent, #4a7dff)',
        borderRadius: 8, padding: 12, marginBottom: 8, cursor: 'pointer',
      },
      meta: { fontSize: 12, opacity: 0.7, marginTop: 4 },
      cardTitle: { fontSize: 13, fontWeight: 500 },
      group: { marginBottom: 14 },
      groupHead: { fontSize: 13, fontWeight: 600, marginBottom: 6 },
      item: { fontSize: 13, padding: '3px 0', opacity: 0.9 },
      note: { fontSize: 12, opacity: 0.75, lineHeight: 1.7, marginTop: 10 },
      warn: { fontSize: 12, lineHeight: 1.7, color: 'var(--dsh-warning, #b8860b)' },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, opacity: 0.8 },
    }

    /**
     * Turn a snapshot into a short label a person can read.
     *
     * The raw name ("snapshot-20261015-172019-interval.json") is a machine
     * artefact: the date is repeated in the timestamp below it and the reason is
     * shown as a translated word, so the file name adds noise rather than
     * information. What the user actually wants to know is when it was taken.
     */
    function snapshotLabel(name) {
      const m = /^snapshot-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(String(name ?? ''))
      if (!m) return String(name ?? '')
      return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`
    }

    /** "3 分钟前" / "刚刚" — friendlier than a raw ISO timestamp. */
    function relativeTime(iso, tr) {
      const then = Date.parse(String(iso ?? ''))
      if (!Number.isFinite(then)) return String(iso ?? '—')
      const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
      if (seconds < 60) return tr('agoJustNow')
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes} ${tr('agoMinutes')}`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours} ${tr('agoHours')}`
      return `${Math.round(hours / 24)} ${tr('agoDays')}`
    }

    function DeskResumePage({ ctx }) {
      const tag = localeTag(ctx)
      const tr = k => (T[tag] ?? T.zh)[k] ?? k

      const [snapshots, setSnapshots] = useState(null)
      const [broken, setBroken] = useState([])
      const [selected, setSelected] = useState(null)
      const [plan, setPlan] = useState(null)
      const [report, setReport] = useState(null)
      // Errors carry the action that failed. The old code had one bare string that
      // was always rendered under the "could not load snapshots" heading, so a
      // failed restore told the user its snapshot list was unreadable.
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState('')
      // Populated only when the host cannot work here at all (not Windows, no
      // PowerShell). Without it the page would offer a restore button that can
      // only fail, which is how a Mac user met `spawn powershell.exe ENOENT`.
      const [env, setEnv] = useState(null)

      const reasonLabel = r => ({
        manual: tr('reasonManual'), interval: tr('reasonInterval'),
        'session-end': tr('reasonSessionEnd'), boot: tr('reasonBoot'),
        'pre-restore': tr('reasonPreRestore'),
      })[r] ?? r

      const fail = (stage, e) => setError({ stage, message: String(e?.message ?? e) })

      const load = useCallback(async () => {
        setError(null)
        try {
          const res = await fetch(`${API}/snapshots`)
          const data = await res.json()
          if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
          setSnapshots(data.snapshots ?? [])
          setBroken(data.broken ?? [])
          if (!selected && (data.snapshots ?? []).length > 0) setSelected(data.snapshots[0].file)
        } catch (e) {
          fail('load', e)
          setSnapshots([])
        }
      }, [selected])

      useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

      useEffect(() => {
        fetch(`${API}/config`)
          .then(r => r.json())
          .then(d => { if (d?.environment && d.environment.ok === false) setEnv(d.environment) })
          .catch(() => { /* the environment is advisory; never block the page */ })
      }, [])

      const doCapture = async () => {
        setBusy('capture'); setError(null); setPlan(null); setReport(null)
        try {
          const res = await fetch(`${API}/capture`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'manual' }),
          })
          const data = await res.json()
          if (!res.ok || data.ok === false) throw new Error(data?.error ?? `HTTP ${res.status}`)
          setSelected(data.outFile ?? null)
          await load()
        } catch (e) { fail('capture', e) }
        finally { setBusy('') }
      }

      const doPlan = async () => {
        if (!selected) return
        setBusy('plan'); setError(null); setReport(null)
        try {
          const res = await fetch(`${API}/plan?file=${encodeURIComponent(selected)}`)
          const data = await res.json()
          if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
          setPlan(data.plan)
        } catch (e) { fail('plan', e) }
        finally { setBusy('') }
      }

      const doRestore = async (mode) => {
        if (!selected) return
        if (!window.confirm(tr('confirm'))) return
        setBusy('restore'); setError(null)
        try {
          const res = await fetch(`${API}/restore`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              file: selected,
              launch: mode !== 'place',
              place: mode !== 'launch',
            }),
          })
          const data = await res.json()

          /*
           * A restore is never all-or-nothing, so its HTTP status cannot be the
           * whole story. The server answers 500 when *any* item failed, yet the
           * apps and folders that did restore are already on the desktop.
           *
           * Treating that 500 as a plain error — as this page used to — threw the
           * report away and showed "could not load snapshots" under a restore the
           * user could plainly see succeed. Whenever the response carries a
           * report, show the report: it lists what worked and what did not. Only
           * a response with no report at all is a genuine request failure.
           */
          if (data?.report) {
            setPlan(data.plan ?? null)
            setReport(data.report)
            if (!res.ok && (data.report.failed ?? []).length === 0) {
              fail('restore', new Error(data?.error ?? `HTTP ${res.status}`))
            }
            return
          }
          if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
          setPlan(data.plan ?? null)
        } catch (e) { fail('restore', e) }
        finally { setBusy('') }
      }

      if (snapshots === null) {
        return h('div', { style: S.wrap }, h('div', { style: S.sub }, tr('loading')))
      }

      const errorHeading = error
        ? { load: tr('loadFailed'), capture: tr('captureFailed'), plan: tr('planFailed'), restore: tr('restoreFailed') }[error.stage]
          ?? tr('loadFailed')
        : ''

      // Documents the plan will open on top of each app's command line. They are
      // listed separately because they are an inference, not something the
      // snapshot observed directly.
      const inferred = []
      for (const e of [...(plan?.launch ?? []), ...(plan?.existing ?? [])]) {
        for (const d of e.inferredDocuments ?? []) inferred.push({ app: e.name ?? e.key, doc: d })
      }

      return h('div', { style: S.wrap },
        h('div', { style: S.h1 }, tr('title')),
        h('div', { style: S.sub }, tr('subtitle')),

        env && h('div', { style: { ...S.warn, border: '1px solid var(--dsh-warning, #b8860b)', borderRadius: 8, padding: 10, marginBottom: 12 } },
          h('div', { style: { fontWeight: 600 } }, tr('envWarning')),
          (env.problems ?? []).map((p, i) => h('div', { key: i }, `- ${p.message}`)),
          (env.problems ?? []).filter(p => p.hint).map((p, i) => h('div', { key: `h${i}`, style: S.meta }, p.hint))),

        h('div', { style: S.row },
          h('button', {
            style: S.btn(true), disabled: busy !== '', onClick: doCapture,
          }, busy === 'capture' ? tr('capturing') : tr('capture')),
          h('button', { style: S.btn(false), disabled: busy !== '', onClick: load }, tr('refresh'))),

        error && h('div', { style: S.warn },
          h('div', null, `${errorHeading}: ${error.message}`),
          // Retry re-runs the action that failed, not the snapshot list.
          h('button', {
            style: { ...S.btn(false), marginTop: 6 },
            onClick: error.stage === 'restore' ? () => doRestore('all') : load,
          }, tr('retry'))),

        snapshots.length === 0
          ? h('div', { style: S.sub }, tr('noSnapshots'))
          : h('div', null,
              h('div', { style: S.groupHead }, `${tr('snapshots')} · ${snapshots.length}`),
              snapshots.slice(0, 20).map(s => h('div', {
                key: s.file,
                style: s.file === selected ? S.cardActive : S.card,
                onClick: () => { setSelected(s.file); setPlan(null); setReport(null) },
              },
                h('div', { style: S.cardTitle },
                  `${snapshotLabel(s.name)} · ${reasonLabel(s.reason)}`),
                h('div', { style: S.meta },
                  `${relativeTime(s.capturedAt, tr)} · ${tr('windows')} ${s.windows} · ${tr('explorer')} ${s.explorer}`)))),

        broken.length > 0 && h('div', { style: S.warn },
          broken.map((b, i) => h('div', { key: i }, `${b.name} — ${b.reason}`))),

        selected && h('div', { style: { ...S.row, marginTop: 12 } },
          h('button', { style: S.btn(false), disabled: busy !== '', onClick: doPlan },
            busy === 'plan' ? tr('planning') : tr('plan')),
          h('button', { style: S.btn(true), disabled: busy !== '', onClick: () => doRestore('all') },
            busy === 'restore' ? tr('restoring') : tr('restore')),
          h('button', { style: S.btn(false), disabled: busy !== '', onClick: () => doRestore('launch') },
            tr('launchOnly')),
          h('button', { style: S.btn(false), disabled: busy !== '', onClick: () => doRestore('place') },
            tr('placeOnly'))),

        plan && h('div', { style: { marginTop: 12 } },
          inferred.length > 0 && h('div', { style: S.group },
            h('div', { style: S.groupHead }, `${tr('inferredDocs')} · ${inferred.length}`),
            h('div', { style: S.note }, tr('inferredHint')),
            inferred.slice(0, 20).map((x, i) => h('div', { key: i, style: S.mono }, `${x.app} ← ${x.doc.path}`))),

          (plan.launch ?? []).length > 0 && h('div', { style: S.group },
            h('div', { style: S.groupHead }, `${tr('willLaunch')} · ${plan.launch.length}`),
            plan.launch.map((e, i) => h('div', { key: i, style: S.item },
              `${e.name} (${e.windowCount})` + (e.args?.length ? ` ← ${e.args.slice(0, 3).join(' ')}` : '')))),

          (plan.existing ?? []).length > 0 && h('div', { style: S.group },
            h('div', { style: S.groupHead }, `${tr('willMove')} · ${plan.existing.length}`),
            plan.existing.map((e, i) => h('div', { key: i, style: S.item }, `${e.name} (${e.windowCount})`))),

          (plan.manual ?? []).length > 0 && h('div', { style: S.group },
            h('div', { style: S.groupHead }, `${tr('willManual')} · ${plan.manual.length}`),
            plan.manual.map((e, i) => h('div', { key: i, style: S.item }, `${e.name} — ${e.note}`))),

          (plan.explorer ?? []).length > 0 && h('div', { style: S.group },
            h('div', { style: S.groupHead }, `${tr('willFolders')} · ${plan.explorer.length}`),
            plan.explorer.slice(0, 15).map((f, i) => h('div', { key: i, style: S.mono }, f.path))),

          (plan.warnings ?? []).length > 0 && h('div', { style: S.group },
            h('div', { style: S.groupHead }, tr('warnings')),
            plan.warnings.map((w, i) => h('div', { key: i, style: S.warn }, `- ${w}`)))),

        report && h('div', { style: { marginTop: 12 } },
          h('div', { style: S.groupHead }, tr('result')),
          h('div', { style: S.item },
            `${tr('launched')} ${report.launched?.length ?? 0} · ` +
            `${tr('placed')} ${report.placed?.length ?? 0} · ` +
            `${tr('openedDocs')} ${report.documents?.length ?? 0} · ` +
            `${tr('failed')} ${report.failed?.length ?? 0}`),
          (report.pending ?? []).length > 0 && h('div', { style: { marginTop: 8 } },
            h('div', { style: S.item }, `${tr('pendingLogin')} · ${report.pending.length}`),
            report.pending.map((p, i) => h('div', { key: i, style: S.note }, `${p.name} — ${p.title ?? ''}：${p.error}`))),
          (report.documents ?? []).length > 0 && h('div', { style: { marginTop: 8 } },
            h('div', { style: S.item }, `${tr('openedDocs')} · ${report.documents.length}`),
            report.documents.slice(0, 20).map((d, i) => h('div', { key: i, style: S.mono }, `${d.app} ← ${d.path}`))),
          (report.failed ?? []).map((f, i) => h('div', { key: `f${i}`, style: S.warn },
            `${f.name ?? f.title} [${f.stage}] — ${f.error}`)),
          (report.notes ?? []).length > 0 && h('div', { style: S.note },
            report.notes.map((n, i) => h('div', { key: i }, `- ${n}`))),
          report.reportFile && h('div', { style: S.meta }, `${tr('reportSaved')}: ${report.reportFile}`)),

        h('div', { style: S.note }, tr('boundary')))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'deskresume',
          order: 62,
          label: () => T[localeTag(ctx)]?.nav ?? T.zh.nav,
        }, props => h(DeskResumePage, { ...props, ctx })))
      },
    }
  },
})
