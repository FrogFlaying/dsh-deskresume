/**
 * How volatile are window titles while the window stays open?
 *
 * This is a zero-risk proxy for the reboot hit rate. Restoring matches windows by
 * title, so the failure mode that matters is "the same window has a different
 * title later". A title that changes every couple of minutes while the app stays
 * open will almost certainly differ after a reboot; a title that is stable for an
 * hour probably will not.
 *
 * Method: track windows by HWND across snapshots. HWND is stable within a login
 * session (all snapshots here come from one session), so:
 *   - same HWND, different title   -> the title genuinely changed  (VOLATILE)
 *   - different HWND, different title -> simply a different window (NOT volatile)
 *
 * An earlier version of this script grouped by process name, which conflated the
 * two: explorer.exe showing 8 titles is 8 windows, not a title that changed. That
 * inflated volatility and understated stability. Grouping by HWND fixes it.
 *
 * It is a proxy, not a substitute: after a reboot each app is relaunched, and
 * whether the app restores its own document is a separate question this cannot
 * answer.
 *
 * Read-only. Usage: node tools/title-stability.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dataDir = path.join(rootDir, 'data')

const files = fs.readdirSync(dataDir)
  .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
  .sort()

if (files.length < 2) {
  console.error('需要至少 2 份快照才能比较标题稳定性。')
  process.exit(1)
}

const snapshots = files.map(f => {
  const doc = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'))
  return { file: f, at: doc.capturedAt, doc }
})

console.log('')
console.log('窗口标题稳定性（重启命中率的零风险代理指标）')
console.log('='.repeat(70))
console.log('')
console.log(`快照数   : ${snapshots.length}`)
console.log(`时间跨度 : ${snapshots[0].at}`)
console.log(`        →  ${snapshots[snapshots.length - 1].at}`)
console.log('')

// hwnd -> { proc, titles:Set, seenIn:count }
const byHwnd = new Map()

for (const snap of snapshots) {
  for (const w of snap.doc.windows ?? []) {
    const hwnd = String(w.hwnd ?? '')
    const title = String(w.title ?? '')
    if (!hwnd || !title) continue
    if (!byHwnd.has(hwnd)) {
      byHwnd.set(hwnd, { hwnd, proc: String(w.name ?? '').toLowerCase(), titles: new Set(), seen: 0 })
    }
    const e = byHwnd.get(hwnd)
    e.titles.add(title)
    e.seen++
  }
}

// Only windows observed at least twice can tell us anything about stability.
const observed = [...byHwnd.values()].filter(e => e.seen >= 2)

const stable = observed.filter(e => e.titles.size === 1)
const changed = observed.filter(e => e.titles.size > 1)

// Weight by observation count: a window seen in 30 snapshots matters more than
// one seen twice.
const totalObs = observed.reduce((a, e) => a + e.seen, 0)
const stableObs = stable.reduce((a, e) => a + e.seen, 0)
const changedObs = changed.reduce((a, e) => a + e.seen, 0)

console.log('按窗口（HWND）判定，只统计出现 ≥2 次的窗口')
console.log('-'.repeat(70))
console.log('')
console.log(`  观测到的窗口     : ${observed.length} 个（共 ${totalObs} 次观测）`)
console.log(`  标题始终不变     : ${stable.length} 个窗口，${stableObs} 次观测 = ${(stableObs / totalObs * 100).toFixed(1)}%`)
console.log(`  标题曾经变化     : ${changed.length} 个窗口，${changedObs} 次观测 = ${(changedObs / totalObs * 100).toFixed(1)}%`)
console.log('')

if (changed.length > 0) {
  console.log('标题变化过的窗口（这些才是真正的风险点）')
  console.log('-'.repeat(70))
  for (const e of changed.sort((a, b) => b.titles.size - a.titles.size)) {
    console.log('')
    console.log(`  ${e.proc}  (hwnd ${e.hwnd}, 观测 ${e.seen} 次, ${e.titles.size} 个不同标题)`)
    for (const t of [...e.titles].slice(0, 5)) {
      const s = t.length > 60 ? t.slice(0, 60) + '…' : t
      console.log(`      · ${s}`)
    }
    if (e.titles.size > 5) console.log(`      … 另有 ${e.titles.size - 5} 个`)
  }
  console.log('')
}

// Which processes contribute the volatile windows?
const volatileByProc = new Map()
for (const e of changed) {
  volatileByProc.set(e.proc, (volatileByProc.get(e.proc) ?? 0) + 1)
}

console.log('='.repeat(70))
console.log('结论')
console.log('')
console.log(`  在 ${observed.length} 个被重复观测的窗口中，${stable.length} 个（${(stable.length / observed.length * 100).toFixed(0)}%）`)
console.log(`  在整个观测期内标题从未改变 —— 这些窗口重启后仍能被标题匹配到。`)
console.log('')
if (volatileByProc.size > 0) {
  const top = [...volatileByProc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  console.log(`  标题会变的窗口集中在这些程序：${top.map(([p, n]) => `${p}(${n})`).join('、')}`)
  console.log('  其中浏览器标签页类窗口的标题随页面内容变化，属于应用自身行为，')
  console.log('  需要应用适配器（P1-3）才能可靠恢复，不是匹配算法能解决的。')
  console.log('')
}
console.log('  重要：这是代理指标，不是命中率预测。它回答「哪些窗口的失败是标题造成的」，')
console.log('  无法回答「重启后程序是否恢复自己的文档」—— 那只能在真实重启（或虚拟机）里测。')
console.log('')
