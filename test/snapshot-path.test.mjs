/**
 * Tests for snapshot path confinement.
 *
 * `pickSnapshot(rootDir, { file })` must only ever return a file inside the
 * snapshot directory. Allowing an arbitrary path turns `restore` into arbitrary
 * program execution: a caller writes its own snapshot JSON naming any executable
 * and arguments, passes that path, and DeskResume launches it. The HTTP API makes
 * that reachable without shell access, so the confinement is a security boundary
 * rather than tidiness.
 *
 * Run: node --test test/snapshot-path.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { pickSnapshot, dataDir } from '../lib/snapshot.js'

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskresume-path-'))
  fs.mkdirSync(dataDir(root), { recursive: true })
  fs.writeFileSync(path.join(dataDir(root), 'snapshot-1-manual.json'), JSON.stringify({
    schemaVersion: 1, capturedAt: 'x', reason: 'manual',
    stats: { windows: 0 }, windows: [], explorer: [],
  }))
  return root
}

test('accepts a snapshot inside the data directory', () => {
  const root = fixtureRoot()
  const file = path.join(dataDir(root), 'snapshot-1-manual.json')
  assert.equal(pickSnapshot(root, { file }), path.resolve(file))
  fs.rmSync(root, { recursive: true, force: true })
})

test('refuses a path outside the data directory', () => {
  const root = fixtureRoot()
  const outside = path.join(root, 'evil.json')
  fs.writeFileSync(outside, '{}')
  assert.throws(() => pickSnapshot(root, { file: outside }), /outside the snapshot directory/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('refuses an absolute path in a temp directory', () => {
  const root = fixtureRoot()
  const tmp = path.join(os.tmpdir(), `deskresume-evil-${Date.now()}.json`)
  fs.writeFileSync(tmp, '{}')
  assert.throws(() => pickSnapshot(root, { file: tmp }), /outside the snapshot directory/)
  fs.rmSync(tmp, { force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

test('refuses traversal that escapes via ..', () => {
  const root = fixtureRoot()
  const sneaky = path.join(dataDir(root), '..', 'evil.json')
  fs.writeFileSync(path.join(root, 'evil.json'), '{}')
  assert.throws(() => pickSnapshot(root, { file: sneaky }), /outside the snapshot directory/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('refuses a sibling directory sharing the data prefix', () => {
  // "data-other" must not be accepted just because it starts with "data".
  const root = fixtureRoot()
  const sibling = path.join(root, 'data-other')
  fs.mkdirSync(sibling, { recursive: true })
  const file = path.join(sibling, 'snapshot-1-manual.json')
  fs.writeFileSync(file, '{}')
  assert.throws(() => pickSnapshot(root, { file }), /outside the snapshot directory/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a missing file inside the directory reports not-found, not a path error', () => {
  const root = fixtureRoot()
  const missing = path.join(dataDir(root), 'snapshot-nope.json')
  assert.throws(() => pickSnapshot(root, { file: missing }), /snapshot not found/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('still picks the newest snapshot when no file is given', () => {
  const root = fixtureRoot()
  const picked = pickSnapshot(root)
  assert.match(picked, /snapshot-1-manual\.json$/)
  fs.rmSync(root, { recursive: true, force: true })
})
