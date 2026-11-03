/**
 * DeskResume — regression tests for the placement request handoff.
 *
 * These lock in the three defects behind one user-visible symptom: "the apps
 * reopened, but the plugin still showed an error."
 *
 *   1. `place.ps1` read a JSON array of N requests as ONE request. On Windows
 *      PowerShell 5.1, `@($raw | ConvertFrom-Json)` wraps the parsed array in a
 *      second array, so `$requests.Count` was 1 and `.title` was an Object[]
 *      holding every title. The first unmatched window then called
 *      `.Substring()` on that Object[], the script died with exit 1, and the
 *      restore placed nothing.
 *
 *   2. The process's stderr was decoded as UTF-8 while PowerShell 5.1 writes the
 *      OEM code page (GBK/936), so the reason was unreadable mojibake.
 *
 *   3. A restore that placed *some* windows answered HTTP 500, and the page
 *      treated that as a total failure — discarding the report and labelling it
 *      "could not load snapshots".
 *
 * The smoke test could not catch (1) because it always sent exactly one request,
 * and a one-element array happens to unwrap to a PSCustomObject. The regression
 * that matters is therefore a request list with more than one entry, which is
 * what a real restore always produces.
 *
 * Run: node --test test/placement-handoff.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const placeScript = path.join(rootDir, 'collector', 'place.ps1')

/**
 * Can this process start a child at all?
 *
 * These tests deliberately drive the real `place.ps1`, which needs a child
 * process with piped stdio. The DSH sandbox refuses exactly that (`spawn EPERM`,
 * by design), and a sandbox denial is not a regression in the script. Rather than
 * report six failures that say nothing about the code, probe once and skip the
 * file with the reason attached — outside the sandbox they run for real, which is
 * where `tools/place.smoke.mjs` and CI exercise the same path.
 */
const spawnBlocked = await new Promise(resolve => {
  try {
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true })
    const done = code => resolve(code === 0 ? null : `powershell exited ${code}`)
    child.on('error', error => resolve(String(error?.code ?? error?.message ?? error)))
    child.on('close', done)
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', () => {})
    setTimeout(() => { try { child.kill() } catch { /* gone */ } resolve('probe timed out') }, 15_000)
  } catch (error) {
    resolve(String(error?.code ?? error?.message ?? error))
  }
})

if (spawnBlocked) {
  // One line, so a reader of the output knows why eight tests vanished.
  console.error(`[deskresume] skipping placement-handoff: cannot start a child process (${spawnBlocked})`)
}

/** `test`, or a skip-with-reason when this process cannot spawn anything. */
const it = spawnBlocked ? (name, fn) => test.skip(`${name} [skipped: ${spawnBlocked}]`, fn) : test

/**
 * Run place.ps1 over a request list and return exit code, raw stderr and result.
 *
 * Requests are matched against window titles that cannot exist, so the test
 * never moves a window: it only exercises the parse-and-match path, which is
 * exactly where the array-unwrapping bug lived.
 */
function runPlace(requests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskresume-handoff-'))
  const inFile = path.join(dir, 'in.json')
  const outFile = path.join(dir, 'out.json')
  fs.writeFileSync(inFile, JSON.stringify(requests), 'utf8')

  return new Promise(resolve => {
    const child = spawn(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', placeScript, '-Json', inFile, '-Out', outFile,
    ], { windowsHide: true })

    const errChunks = []
    child.stdout.on('data', () => {})
    child.stderr.on('data', c => errChunks.push(Buffer.from(c)))
    child.on('close', code => {
      const stderrBuf = Buffer.concat(errChunks)
      let result = null
      try { result = JSON.parse(fs.readFileSync(outFile, 'utf8')) } catch { /* no result */ }
      fs.rmSync(dir, { recursive: true, force: true })
      resolve({ code, stderrBuf, result })
    })
  })
}

/** A request naming a window title that cannot exist on any machine. */
function impossibleRequest(n, title) {
  return {
    title: title ?? `DeskResume Test Window ${n} 不存在的窗口 ${n}`,
    class: null, state: 'normal',
    x: 10, y: 10, w: 400, h: 300, monitor: null,
  }
}

it('a multi-request list is read as N requests, not as one array', async () => {
  // The regression: with the old `@($raw | ConvertFrom-Json)`, this list became a
  // single request whose title was an Object[], and place.ps1 exited 1 having
  // placed nothing. Three entries is the smallest list that still differs from
  // the one-element shape the smoke test used.
  const requests = [
    impossibleRequest(1),
    impossibleRequest(2),
    impossibleRequest(3, 'DeskResume Test Window 3 - 中文标题'),
  ]
  const { code, stderrBuf, result } = await runPlace(requests)

  assert.equal(code, 0,
    `place.ps1 must not fail on a multi-request list; stderr=${stderrBuf.toString('utf8').slice(0, 200)}`)
  assert.ok(result, 'place.ps1 must write a result file')
  // Every request must be reported individually, proving the array was unrolled.
  assert.equal(result.failed.length, 3,
    `expected one failure per request, got ${result.failed.length}`)
  assert.equal(result.placed.length, 0, 'titles that cannot exist must not match')
  for (const f of result.failed) {
    assert.equal(f.error, 'window not found')
    assert.equal(typeof f.title, 'string', 'the reported title must be a string, not an array')
  }
})

it('each request keeps its own title instead of inheriting the whole array', async () => {
  const titles = ['DeskResume Alpha 甲', 'DeskResume Beta 乙', 'DeskResume Gamma 丙']
  const { result } = await runPlace(titles.map((t, i) => impossibleRequest(i, t)))

  assert.ok(result)
  const reported = result.failed.map(f => f.title).sort()
  assert.deepEqual(reported, [...titles].sort(),
    'each saved title must be reported back verbatim, not collapsed into one')
})

it('a single request still works (the shape the smoke test uses)', async () => {
  const { code, result } = await runPlace([impossibleRequest(1)])
  assert.equal(code, 0)
  assert.ok(result)
  assert.equal(result.failed.length, 1)
  assert.equal(result.placed.length, 0)
})

it('an empty list is a clean no-op, not an error', async () => {
  const { code, result } = await runPlace([])
  assert.equal(code, 0)
  assert.ok(result, 'an empty request list must still produce a result file')
  assert.equal(result.placed.length, 0)
  assert.equal(result.failed.length, 0)
})

it('a malformed request cannot abort placement for the others', async () => {
  // A non-object entry used to reach the matching code and throw, killing the
  // whole run. It must be skipped while the well-formed requests still report.
  const { code, result } = await runPlace([
    impossibleRequest(1),
    { title: null, x: 0, y: 0, w: 0, h: 0 },
    impossibleRequest(2),
  ])
  assert.equal(code, 0, 'one malformed request must not fail the whole script')
  assert.ok(result)
  assert.equal(result.failed.length, 2,
    `the two valid requests must still be reported; got ${result.failed.length}`)
})

it('stderr is UTF-8, so a failure reason is readable rather than mojibake', async () => {
  // place.ps1 declares [Console]::OutputEncoding = UTF8. Without it PowerShell
  // 5.1 writes GBK bytes and the Node side's UTF-8 decode produced the garbage
  // the user reported. Any localized text in an error message is the tell.
  const { stderrBuf } = await runPlace([impossibleRequest(1)])
  const text = stderrBuf.toString('utf8')
  // No failure is expected here; the assertion that matters is that whatever
  // *is* written decodes cleanly as UTF-8 (no replacement characters).
  assert.ok(!text.includes('\uFFFD'),
    `stderr must decode as valid UTF-8, got: ${JSON.stringify(text.slice(0, 200))}`)
})

it('the script declares a UTF-8 output encoding', () => {
  // Guard the fix itself: a refactor that drops this line silently reintroduces
  // unreadable diagnostics, and nothing else in the suite would notice.
  const source = fs.readFileSync(placeScript, 'utf8')
  assert.match(source, /\[Console\]::OutputEncoding\s*=\s*\[System\.Text\.Encoding\]::UTF8/,
    'place.ps1 must set Console.OutputEncoding to UTF-8')
})

it('the request list is unrolled explicitly, not double-wrapped', () => {
  // The exact bug shape. `@($parsed)` would re-introduce it, so pin the form that
  // actually unrolls the array PS 5.1 hands back as a single pipeline object.
  //
  // Comments are stripped first: the fix's own explanation quotes the broken
  // expression verbatim, and a naive scan would flag that documentation.
  const source = fs.readFileSync(placeScript, 'utf8')
  const code = source.split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n')

  assert.ok(!/@\(\$raw\s*\|\s*ConvertFrom-Json\)/.test(code),
    'the double-wrapping `@($raw | ConvertFrom-Json)` must not come back')
  assert.match(code, /ForEach-Object\s*\{\s*\$_?\s*\}/,
    'the parsed array must be unrolled explicitly')
})
