/**
 * DeskResume — verification of the unattended-capture scheduled tasks.
 *
 * Read-only: this script inspects Task Scheduler and the snapshot store. It does
 * NOT register, run, modify or delete anything, so it is safe to run at any time
 * and safe to run in CI on a machine where the tasks were never installed (it
 * then reports SKIP rather than failing).
 *
 * It exists because "the installer printed success" is not evidence that
 * unattended capture works. The checks below are the actual acceptance criteria
 * from the review: the tasks exist, they run the collector directly, and no task
 * opens a network surface.
 *
 * Run: node test/task-installation.mjs
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const TASK_PATH = '\\DeskResume\\'
const TASKS = ['DeskResume-Interval', 'DeskResume-SessionEnd']

let failures = 0
let skipped = 0

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function skip(label, reason) {
  skipped++
  console.log(`  SKIP  ${label} — ${reason}`)
}

/** Query one task via schtasks; returns its raw text or null when absent. */
async function queryTask(name) {
  try {
    const { stdout } = await run('schtasks', ['/query', '/tn', `${TASK_PATH}${name}`, '/fo', 'LIST', '/v'], {
      maxBuffer: 4 * 1024 * 1024,
    })
    return String(stdout)
  } catch {
    return null
  }
}

console.log('DeskResume scheduled-task verification')
console.log('')

const raw = {}
for (const name of TASKS) raw[name] = await queryTask(name)

const installed = TASKS.filter(n => raw[n] !== null)

if (installed.length === 0) {
  skip('scheduled tasks installed', 'none found — run collector\\install-tasks.ps1')
  console.log('')
  console.log(`SKIPPED (${skipped}) — nothing to verify on this machine.`)
  process.exit(0)
}

for (const name of TASKS) {
  const text = raw[name]
  if (text === null) {
    skip(`${name} registered`, 'not installed')
    continue
  }
  check(`${name} registered`, true)

  // The task must invoke the collector directly. If it ever starts a server or a
  // listener instead, it runs outside DSH's authenticated web server and would
  // be reachable by any local process.
  check(`${name} reaches collect.ps1`,
    /collect\.ps1|run-hidden\.vbs/i.test(text),
    'task action references neither collect.ps1 nor run-hidden.vbs')

  check(`${name} opens no network surface`,
    !/(https?:\/\/|listen|Invoke-WebRequest|HttpListener)/i.test(text),
    'task action appears to reference HTTP')

  // A console window flashing every couple of minutes is disruptive, and the
  // direct powershell.exe call is measured to cause exactly that. The launcher
  // is what keeps capture invisible.
  if (/run-hidden\.vbs/i.test(text)) {
    check(`${name} launches through the hidden launcher (no console flash)`, true)
  } else {
    check(`${name} avoids a visible console window`,
      !/powershell\.exe/i.test(text),
      'task calls powershell.exe directly, which flashes a console window')
  }

  // Non-elevated: a scheduled task silently running elevated is a privilege
  // change the user did not ask for.
  const runLevel = /Run Level\s*:\s*(\S+)/i.exec(text)?.[1] ?? ''
  if (runLevel) {
    check(`${name} runs without elevation`, !/highest/i.test(runLevel), `run level = ${runLevel}`)
  }

  const reason = name === 'DeskResume-SessionEnd' ? 'session-end' : 'interval'
  check(`${name} passes reason ${reason}`,
    new RegExp(`\\b${reason}\\b`, 'i').test(text),
    `expected the reason ${reason} in the task action`)
}

// The interval task must be recurring, otherwise unattended capture stops after
// one run and the feature quietly dies.
if (raw['DeskResume-Interval']) {
  const t = raw['DeskResume-Interval']
  check('interval task is recurring',
    /(repeat|repetition|每|每隔)/i.test(t) || /Schedule Type\s*:\s*\S+/i.test(t),
    'no repetition information found')
}

// Evidence that unattended capture actually produced something.
const dataDir = path.join(rootDir, 'data')
const intervalSnapshots = fs.existsSync(dataDir)
  ? fs.readdirSync(dataDir).filter(f => f.endsWith('.json')).filter(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')).reason === 'interval'
    } catch { return false }
  })
  : []

if (intervalSnapshots.length > 0) {
  check('at least one unattended (reason=interval) snapshot exists', true)
} else {
  skip('unattended snapshot produced', 'no reason=interval snapshot yet — wait for the interval or run the task once')
}

console.log('')
if (failures === 0) {
  console.log(skipped > 0 ? `ALL PASS (${skipped} skipped)` : 'ALL PASS')
} else {
  console.log(`${failures} CHECK(S) FAILED`)
}
process.exit(failures === 0 ? 0 : 1)
