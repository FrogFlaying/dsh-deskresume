/**
 * DeskResume — collector runner.
 *
 * Spawns `collector/collect.ps1` and parses its stdout summary. The PowerShell
 * script owns all Windows API access; this module only marshals arguments and
 * normalises failures into a shape the host can report.
 *
 * Deliberate constraint: this module never runs the collector with elevated
 * rights. An elevated collector would read other users' processes but would
 * also mean the plugin silently triggers UAC, which is not a plugin's call.
 *
 * @module lib/collector.js
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe'

/**
 * Run the collector once.
 *
 * @param {object} options
 * @param {string} options.rootDir      Project root (holds collector/ and data/).
 * @param {string} [options.reason]     manual | interval | session-end | boot | pre-restore
 * @param {string} [options.outFile]    Explicit output path.
 * @param {boolean} [options.terminalCwd] Attempt PEB working-directory reads.
 * @param {number} [options.keep]       Retention count.
 * @param {number} [options.timeoutMs]  Kill the collector after this long.
 * @returns {Promise<{ok: boolean, outFile?: string, stats?: object, channels?: object, error?: string, log?: string[]}>}
 */
export function runCollector(options) {
  const {
    rootDir,
    reason = 'manual',
    outFile,
    terminalCwd = false,
    keep = 30,
    timeoutMs = 60_000,
  } = options

  const script = path.join(rootDir, 'collector', 'collect.ps1')
  if (!fs.existsSync(script)) {
    return Promise.resolve({ ok: false, error: `collector not found: ${script}` })
  }

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-Reason', reason,
    '-Keep', String(keep),
  ]
  if (outFile) args.push('-OutFile', outFile)
  if (terminalCwd) args.push('-IncludeTerminalCwd')

  return new Promise(resolve => {
    let child
    try {
      child = spawn(POWERSHELL, args, { windowsHide: true })
    } catch (error) {
      return resolve({ ok: false, error: `failed to start powershell: ${error?.message ?? error}` })
    }

    const log = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* already gone */ }
      resolve({ ok: false, error: `collector timed out after ${timeoutMs}ms`, log })
    }, timeoutMs)

    const onLine = chunk => {
      const text = String(chunk)
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim()
        if (t) log.push(t)
      }
    }
    child.stdout.on('data', onLine)
    child.stderr.on('data', onLine)

    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, error: String(error?.message ?? error), log })
    })

    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (code !== 0) {
        return resolve({
          ok: false,
          error: `collector exited with code ${code}`,
          log,
        })
      }
      // The script prints progress lines, then one compact JSON summary last.
      let summary = null
      for (let i = log.length - 1; i >= 0; i--) {
        if (!log[i].startsWith('{')) continue
        try {
          const parsed = JSON.parse(log[i])
          if (parsed && typeof parsed === 'object' && 'ok' in parsed) { summary = parsed; break }
        } catch { /* not the summary line */ }
      }
      if (!summary) {
        return resolve({ ok: false, error: 'collector produced no parseable summary', log })
      }
      resolve({ ...summary, log })
    })
  })
}

/*
 * Note on detecting shutdown: there is deliberately no `isSessionEnding()` here.
 * WM_QUERYENDSESSION has no polling equivalent, so a plugin running inside DSH
 * cannot observe it — an earlier version exported a stub that always returned
 * false, which only invited callers to believe the capability existed. Tagging a
 * snapshot as `session-end` is the job of the scheduled task (see
 * `collector/install-tasks.ps1`), which runs outside DSH and does receive the
 * session-end event.
 */

export { POWERSHELL }
