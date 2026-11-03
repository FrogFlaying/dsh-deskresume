/**
 * DeskResume — post-reboot verification helper.
 *
 * Run this after a real restart to answer one question: how many of the windows
 * that were open before the reboot came back? That number is the title-match hit
 * rate, and it cannot be measured any other way — no amount of testing in a live
 * session reproduces "the window titles after a reboot".
 *
 * Default is READ-ONLY (plan only). Nothing on the desktop changes unless the
 * --restore flag is passed explicitly.
 *
 * Usage:
 *   node tools/verify-after-reboot.mjs            # plan only (safe, default)
 *   node tools/verify-after-reboot.mjs --restore  # actually restore
 *   node tools/verify-after-reboot.mjs --file data/snapshot-....json
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { pickSnapshot, readSnapshot, planRestore, listSnapshots } from '../lib/snapshot.js'
import { executeRestore } from '../lib/restore.js'

const run = promisify(execFile)
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const argv = process.argv.slice(2)
const doRestore = argv.includes('--restore')
const fileArgIdx = argv.indexOf('--file')
const explicitFile = fileArgIdx >= 0 ? argv[fileArgIdx + 1] : null

function line(label, value) {
  console.log(`  ${String(label).padEnd(22)}: ${value}`)
}

/** Names of processes running right now, for the already-open check. */
async function runningProcessNames() {
  try {
    const { stdout } = await run('tasklist', ['/FO', 'CSV', '/NH'], { maxBuffer: 8 * 1024 * 1024 })
    const names = new Set()
    for (const l of String(stdout).split(/\r?\n/)) {
      const m = l.match(/^"([^"]+)"/)
      if (m) names.add(m[1].toLowerCase())
    }
    return names
  } catch {
    return new Set()
  }
}

console.log('')
console.log('DeskResume 重启后验证')
console.log('='.repeat(52))
console.log('')

// ── which snapshot are we restoring? ────────────────────────────────────────
let file
try {
  file = pickSnapshot(rootDir, { file: explicitFile ?? undefined })
} catch (error) {
  console.error(`找不到可用快照：${error.message}`)
  console.error('')
  console.error('先确认定时快照在跑：')
  console.error('  node test/task-installation.mjs')
  process.exit(1)
}

const doc = readSnapshot(file)
const all = listSnapshots(rootDir)

console.log('快照信息')
line('文件', path.basename(file))
line('采集时间', doc.capturedAt ?? '(未知)')
line('采集原因', doc.reason ?? '(未知)')
line('窗口数', doc.stats?.windows ?? (doc.windows ?? []).length)
line('可用快照总数', all.snapshots.length)
if (doc.reason !== 'session-end') {
  console.log('')
  console.log(`  提示：选中的不是关机前快照（reason=${doc.reason}）。`)
  console.log('  若这次是重启后首次运行，正常；否则可用 --file 指定具体快照。')
}

// ── plan ────────────────────────────────────────────────────────────────────
const running = await runningProcessNames()
const plan = planRestore(doc, { runningProcesses: [...running] })

console.log('')
console.log('恢复方案（这一步是只读的，桌面没有任何变化）')
line('将启动', `${plan.launch.length} 个`)
line('已在运行（只摆窗口）', `${plan.existing.length} 个`)
line('需手动处理', `${plan.manual.length} 个`)
line('将重开的文件夹', `${plan.explorer.length} 个`)
line('可还原到具体文档', `${plan.launch.filter(e => e.args.length).length} 个`)

if (plan.launch.length > 0) {
  console.log('')
  console.log('  将启动的程序：')
  for (const e of plan.launch) {
    const docs = e.args.length > 0 ? `  <- ${e.args.join(' ')}` : ''
    console.log(`    ${e.name}${docs}`)
  }
}
if (plan.manual.length > 0) {
  console.log('')
  console.log('  需要手动处理：')
  for (const e of plan.manual) console.log(`    ${e.name} — ${e.note}`)
}
if (plan.explorer.length > 0) {
  console.log('')
  console.log('  将重开的文件夹：')
  for (const f of plan.explorer.slice(0, 15)) console.log(`    ${f.path}`)
}

if (plan.warnings.length > 0) {
  console.log('')
  console.log('  注意：')
  for (const w of plan.warnings) console.log(`    - ${w}`)
}

// ── stop here unless asked to act ───────────────────────────────────────────
if (!doRestore) {
  console.log('')
  console.log('='.repeat(52))
  console.log('以上只是预览，没有改动桌面。')
  console.log('')
  console.log('确认无误后执行恢复：')
  console.log('  node tools/verify-after-reboot.mjs --restore')
  console.log('')
  console.log('把上面的输出整段贴给助手即可。')
  process.exit(0)
}

// ── restore ─────────────────────────────────────────────────────────────────
console.log('')
console.log('='.repeat(52))
console.log('开始恢复…（会启动程序并移动窗口，请勿操作鼠标）')
console.log('')

const report = await executeRestore(plan, { rootDir })

console.log('')
console.log('恢复结果')
console.log('='.repeat(52))
line('已启动', `${report.launched.length} 个`)
line('已重开文件夹', `${report.reopened.length} 个`)
line('已定位窗口', `${report.placed.length} 个`)
line('失败', `${report.failed.length} 个`)

// Hit rate: of the windows we tried to place, how many were found and moved?
const attempted = report.placed.length + report.failed.filter(f => f.stage === 'place').length
if (attempted > 0) {
  const rate = ((report.placed.length / attempted) * 100).toFixed(1)
  console.log('')
  console.log(`  标题匹配命中率：${report.placed.length}/${attempted} = ${rate}%`)
}

if (report.failed.length > 0) {
  console.log('')
  console.log('失败明细：')
  for (const f of report.failed) {
    console.log(`  ${f.name ?? f.title ?? '(未知)'} [${f.stage}] — ${f.error}`)
    if (Array.isArray(f.candidates) && f.candidates.length > 0) {
      console.log(`      当时存在相似窗口：${f.candidates.slice(0, 3).join(' | ')}`)
    }
  }
}

if (report.notes.length > 0) {
  console.log('')
  console.log('说明：')
  for (const n of report.notes) console.log(`  - ${n}`)
}

// Persist the measurement so it can be pasted back or archived.
const outDir = path.join(rootDir, 'data')
try {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = path.join(outDir, `reboot-verify-${stamp}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    verifiedAt: new Date().toISOString(),
    snapshot: path.basename(file),
    snapshotReason: doc.reason,
    snapshotCapturedAt: doc.capturedAt,
    attempted,
    placed: report.placed.length,
    failed: report.failed.length,
    launched: report.launched.length,
    reopened: report.reopened.length,
    hitRatePercent: attempted > 0 ? Number(((report.placed.length / attempted) * 100).toFixed(1)) : null,
    failures: report.failed,
  }, null, 2), 'utf8')
  console.log('')
  console.log(`结果已保存：${outFile}`)
  console.log('（该文件与快照一样已被 .gitignore 排除，不会进版本库）')
} catch (error) {
  console.log(`（结果文件写入失败：${error.message}）`)
}

console.log('')
console.log('把上面的输出整段贴给助手，即可更新能力报告。')
