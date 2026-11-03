/**
 * DeskResume — the document index behind inferred documents.
 *
 * Runs `collector/recent-docs.ps1` and caches its answer. The scan walks a few
 * thousand registry values and a few hundred shortcuts and then calls
 * `Test-Path` on every candidate, which is fine once but not on every plan
 * preview, so the result is cached in `.dr-state/recent-docs.json` for a few
 * minutes. A stale cache is never a correctness problem: entries are re-checked
 * with `stat` at the moment they are used, and a missing file is simply dropped.
 *
 * Failures are never fatal. If WPS is not installed, if the registry key is
 * absent, if PowerShell refuses, the index is empty and the plan is exactly what
 * it was before this feature existed.
 *
 * @module lib/recent-index.js
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { POWERSHELL } from './collector.js'
import { checkEnvironment } from './environment.js'

export const CACHE_TTL_MS = 15 * 60 * 1000

export function cachePath(rootDir) {
  return path.join(rootDir, '.dr-state', 'recent-docs.json')
}

/** Read the cache if it is fresh enough. Never throws. */
export function readCachedIndex(rootDir, options = {}) {
  const { ttlMs = CACHE_TTL_MS, now = Date.now(), refresh = false } = options
  if (refresh) return null
  try {
    const file = cachePath(rootDir)
    const st = fs.statSync(file)
    if (now - st.mtimeMs > ttlMs) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Spawn the scanner once. Resolves with the parsed JSON, or an error. */
function runScanner(rootDir, { timeoutMs = 30_000, maxAgeDays = 90 } = {}) {
  return new Promise(resolve => {
    const script = path.join(rootDir, 'collector', 'recent-docs.ps1')
    if (!fs.existsSync(script)) return resolve({ ok: false, error: `scanner not found: ${script}` })

    let tmpDir
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskresume-docs-'))
    } catch (error) {
      return resolve({ ok: false, error: String(error?.message ?? error) })
    }
    const outFile = path.join(tmpDir, 'index.json')
    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ } }

    let child
    try {
      child = spawn(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Out', outFile, '-MaxAgeDays', String(maxAgeDays),
      ], { windowsHide: true })
    } catch (error) {
      cleanup()
      return resolve({ ok: false, error: `failed to start powershell: ${error?.message ?? error}` })
    }

    let settled = false
    let stderr = ''
    const finish = payload => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      resolve(payload)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish({ ok: false, error: `document scan timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    child.stderr.on('data', c => { stderr += String(c) })
    child.stdout.on('data', () => { /* progress only; the answer is the file */ })
    child.on('error', error => finish({ ok: false, error: String(error?.message ?? error) }))
    child.on('close', code => {
      if (code !== 0) {
        return finish({ ok: false, error: `scanner exited ${code}: ${stderr.trim().slice(0, 300)}` })
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'))
        finish({ ok: true, doc: parsed })
      } catch (error) {
        finish({ ok: false, error: `unreadable scanner output: ${error?.message ?? error}` })
      }
    })
  })
}

/**
 * The document index, from cache when possible.
 *
 * @param {string} rootDir
 * @param {object} [options]
 * @param {boolean} [options.refresh]      Ignore the cache.
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxAgeDays]
 * @returns {Promise<{ok: boolean, doc: object, fromCache: boolean, error?: string}>}
 */
export async function loadRecentDocumentIndex(rootDir, options = {}) {
  const empty = { ok: true, doc: { entries: [], generatedAt: null }, fromCache: false }

  // On a host that cannot run the scanner at all, do not even try: the caller
  // already reports the environment problem once, in clearer words.
  const env = checkEnvironment()
  if (!env.ok) return { ...empty, error: env.problems[0]?.message }

  const cached = readCachedIndex(rootDir, options)
  if (cached) return { ok: true, doc: cached, fromCache: true }

  const result = await runScanner(rootDir, options)
  if (!result.ok) return { ...empty, error: result.error }

  try {
    const file = cachePath(rootDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const utf8 = JSON.stringify(result.doc)
    fs.writeFileSync(file, utf8, 'utf8')
  } catch { /* the cache is an optimisation; the answer stands without it */ }

  return { ok: true, doc: result.doc, fromCache: false }
}
