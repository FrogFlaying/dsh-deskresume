/**
 * DeskResume — the environment self-check.
 *
 * The point of this module is a sentence instead of a stack trace: on macOS the
 * plugin used to load, list nothing, and fail a capture with
 * `spawn powershell.exe ENOENT`. These tests pin both halves — a supported host
 * passes, and an unsupported one is told why in words that name the platform.
 *
 * A case that fakes a non-Windows host is included because the real check reads
 * `process.platform`, which a test cannot change.
 *
 * Run: node test/environment.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'

import {
  checkEnvironment, describeEnvironmentProblem, describeEnvironment, assertSupportedEnvironment,
} from '../lib/environment.js'

const supported = process.platform === 'win32'

test('this host is reported with concrete facts', () => {
  const env = checkEnvironment()
  assert.equal(env.platform, process.platform)
  assert.equal(env.facts.windows, supported)
  assert.equal(typeof env.ok, 'boolean')
  if (supported) {
    // The machine this project is developed on is Windows 10/11, so the check
    // must pass there and must have located PowerShell.
    assert.ok(env.facts.powershell, 'PowerShell path should be resolved on Windows')
    assert.equal(env.ok, true)
    assert.deepEqual(env.problems, [])
    assert.equal(Number.isInteger(env.facts.build), true)
  }
})

test('describeEnvironmentProblem is empty when everything is fine', () => {
  assert.equal(describeEnvironmentProblem({ ok: true, problems: [] }), '')
})

test('an unsupported platform produces an actionable sentence', () => {
  const env = {
    ok: false,
    platform: 'darwin',
    facts: { windows: false, build: null, release: '23.0.0', powershell: null },
    problems: [
      { code: 'not-windows', message: '桌面续开只在 Windows 上可用，当前系统是 macOS。', hint: '需要另做实现。' },
    ],
  }
  const text = describeEnvironmentProblem(env)
  assert.match(text, /只在 Windows 上可用/)
  assert.match(text, /macOS/)
  assert.match(text, /需要另做实现/)
})

test('describeEnvironment summarizes the host in one line', () => {
  const env = checkEnvironment()
  const line = describeEnvironment(env)
  assert.ok(line.length > 0)
  if (supported) assert.match(line, /Windows/)
  assert.equal(describeEnvironment(null), '')
})

test('assertSupportedEnvironment throws only on an unsupported host', () => {
  if (supported) {
    assert.doesNotThrow(() => assertSupportedEnvironment())
  } else {
    assert.throws(() => assertSupportedEnvironment(), /只在 Windows 上可用/)
  }
})

test('build detection matches the running OS version', () => {
  const env = checkEnvironment()
  if (!supported) return
  const build = Number(String(os.release()).split('.')[2])
  assert.equal(env.facts.build, Number.isFinite(build) ? build : env.facts.build)
})
