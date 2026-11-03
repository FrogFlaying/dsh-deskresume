/**
 * DeskResume — tests for the configuration layer and snapshot migration.
 *
 * Both modules exist to make failure modes graceful rather than fatal: a broken
 * config file must fall back to defaults instead of blocking capture, and an
 * old-format snapshot must still be readable because after a power cut it may be
 * the only record of the user's session.
 *
 * Run: node --test test/config.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig, DEFAULTS, shippedConfigPath, localConfigPath } from '../lib/config.js'
import { migrateSnapshot, readSnapshot, SNAPSHOT_SCHEMA_VERSION } from '../lib/snapshot.js'

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deskresume-config-'))
}

test('loadConfig falls back to defaults when no config file exists', () => {
  const root = tmpRoot()
  const { config, sources, problems } = loadConfig(root)
  assert.equal(config.intervalSeconds, DEFAULTS.intervalSeconds)
  assert.equal(config.keepSnapshots, DEFAULTS.keepSnapshots)
  assert.deepEqual(sources, [])
  assert.deepEqual(problems, [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('the shipped config keeps the documented interval and retention', () => {
  // The interval and the retention count together decide how far back the
  // history reaches, which is the number the user actually cares about. Pin both
  // so a change to one is a deliberate decision rather than an accident.
  const shipped = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'config', 'deskresume.json'), 'utf8'),
  )
  assert.equal(shipped.intervalSeconds, 600, 'interval should be 10 minutes')
  assert.equal(shipped.keepSnapshots, 144)

  const coverageSeconds = shipped.intervalSeconds * shipped.keepSnapshots
  assert.equal(coverageSeconds, 86400, 'documented history coverage is 24 hours')
  assert.equal(coverageSeconds / 3600, 24)
})

test('the README states the same coverage the config produces', () => {
  // An earlier README claimed 120s x 30 = 10 hours, which is 1 hour. The number
  // is what the user plans around, so derive it here and require the README to
  // agree; that way docs and config cannot drift apart silently.
  const shipped = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'config', 'deskresume.json'), 'utf8'),
  )
  const coverageHours = (shipped.intervalSeconds * shipped.keepSnapshots) / 3600
  assert.equal(coverageHours, 24)

  const readme = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8')
  assert.match(
    readme,
    /86400 秒 = \*\*24 小时\*\*/,
    'README must state the 24-hour coverage the config actually produces',
  )
  // Guard the specific arithmetic error that shipped: 120 x 30 is one hour.
  assert.equal((120 * 30) / 3600, 1)
  assert.ok(
    !/120 .*30.*10 小时/.test(readme),
    'README must not repeat the 120x30=10-hour error',
  )
})

test('a malformed config file is reported but does not throw', () => {
  const root = tmpRoot()
  fs.mkdirSync(path.dirname(shippedConfigPath(root)), { recursive: true })
  fs.writeFileSync(shippedConfigPath(root), '{ this is not json')
  const { config, problems } = loadConfig(root)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /deskresume\.json/)
  // Defaults still apply: a bad config must never block a snapshot.
  assert.equal(config.intervalSeconds, DEFAULTS.intervalSeconds)
  fs.rmSync(root, { recursive: true, force: true })
})

test('local config overrides the shipped one', () => {
  const root = tmpRoot()
  fs.mkdirSync(path.dirname(shippedConfigPath(root)), { recursive: true })
  fs.writeFileSync(shippedConfigPath(root), JSON.stringify({ intervalSeconds: 300, keepSnapshots: 10 }))
  fs.writeFileSync(localConfigPath(root), JSON.stringify({ intervalSeconds: 60 }))
  const { config } = loadConfig(root)
  assert.equal(config.intervalSeconds, 60)   // overridden
  assert.equal(config.keepSnapshots, 10)     // inherited from shipped
  fs.rmSync(root, { recursive: true, force: true })
})

test('explicit overrides win over every file', () => {
  const root = tmpRoot()
  fs.mkdirSync(path.dirname(shippedConfigPath(root)), { recursive: true })
  fs.writeFileSync(shippedConfigPath(root), JSON.stringify({ intervalSeconds: 300 }))
  const { config } = loadConfig(root, { intervalSeconds: 45 })
  assert.equal(config.intervalSeconds, 45)
  fs.rmSync(root, { recursive: true, force: true })
})

test('nonsensical values are clamped rather than accepted', () => {
  const root = tmpRoot()
  fs.mkdirSync(path.dirname(shippedConfigPath(root)), { recursive: true })
  fs.writeFileSync(shippedConfigPath(root), JSON.stringify({
    intervalSeconds: -5, keepSnapshots: 0, terminalCwd: 'yes',
    extraExcludedProcesses: ['ok.exe', '', 42],
  }))
  const { config } = loadConfig(root)
  assert.equal(config.intervalSeconds, DEFAULTS.intervalSeconds)  // negative rejected
  assert.equal(config.keepSnapshots, DEFAULTS.keepSnapshots)      // zero rejected
  assert.equal(config.terminalCwd, false)                         // only literal true
  assert.deepEqual(config.extraExcludedProcesses, ['ok.exe'])     // non-strings dropped
  fs.rmSync(root, { recursive: true, force: true })
})

test('migrateSnapshot accepts the current version unchanged', () => {
  const doc = { schemaVersion: SNAPSHOT_SCHEMA_VERSION, windows: [] }
  assert.equal(migrateSnapshot(doc).schemaVersion, SNAPSHOT_SCHEMA_VERSION)
})

test('migrateSnapshot refuses a newer version instead of guessing', () => {
  assert.throws(
    () => migrateSnapshot({ schemaVersion: SNAPSHOT_SCHEMA_VERSION + 1, windows: [] }, 'x.json'),
    /newer than this build supports/,
  )
})

test('migrateSnapshot rejects a missing version', () => {
  assert.throws(() => migrateSnapshot({ windows: [] }, 'x.json'), /schemaVersion/)
})

test('readSnapshot still rejects a version with no migration path', () => {
  const root = tmpRoot()
  const file = path.join(root, 'snapshot-old.json')
  // Version 0 is below the first schema, and no migration is registered for it.
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 0, windows: [] }))
  assert.throws(() => readSnapshot(file), /no migration path/)
  fs.rmSync(root, { recursive: true, force: true })
})
