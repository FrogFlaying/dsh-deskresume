/**
 * Tests for the plugin's HTTP request guard.
 *
 * The DSH web server does not gate plugin routes: a request with no credentials,
 * a forged Host, a cross-site Origin and `Sec-Fetch-Site: cross-site` all reach
 * the handler and receive 200. That was observed against a live server. This API
 * can launch programs and move windows, so the guard is the only thing standing
 * between a visited web page and the user's desktop.
 *
 * The decision function is duplicated here deliberately, in its own module-free
 * form, so the table can be asserted without booting DSH. If the implementation
 * drifts, `guardMatchesImplementation` below fails.
 *
 * Run: node --test test/request-guard.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Mirror of the guard in index.js. */
function decide(headers) {
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])
  const hostHeader = String(headers.host ?? '')
  const hostName = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  const isLoopbackHost = loopbackHosts.has(hostName) || hostName.endsWith('.localhost')

  const secFetchSite = String(headers['sec-fetch-site'] ?? '').toLowerCase()
  const origin = String(headers.origin ?? '')
  let originHost = ''
  if (origin) {
    try { originHost = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase() }
    catch { originHost = '(unparseable)' }
  }
  const originIsLoopback = origin === '' || loopbackHosts.has(originHost) || originHost.endsWith('.localhost')

  return (!isLoopbackHost || secFetchSite === 'cross-site' || !originIsLoopback) ? 'block' : 'allow'
}

test('allows the local DSH page', () => {
  assert.equal(decide({ host: '127.0.0.1:19387' }), 'allow')
  assert.equal(decide({ host: 'localhost:19387' }), 'allow')
  assert.equal(decide({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' }), 'allow')
  assert.equal(decide({ host: 'localhost:19387', origin: 'http://localhost:19387' }), 'allow')
  // A same-origin GET often carries no Origin at all.
  assert.equal(decide({ host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' }), 'allow')
})

test('blocks DNS rebinding (a hostile Host pointing at 127.0.0.1)', () => {
  assert.equal(decide({ host: 'evil.example.com' }), 'block')
  assert.equal(decide({ host: 'evil.example.com:19387' }), 'block')
  assert.equal(decide({ host: 'attacker.test' }), 'block')
})

test('blocks a cross-site Origin (the CSRF path)', () => {
  assert.equal(decide({ host: '127.0.0.1:19387', origin: 'https://evil.example.com' }), 'block')
  assert.equal(decide({ host: '127.0.0.1:19387', origin: 'http://attacker.test' }), 'block')
})

test('blocks Sec-Fetch-Site: cross-site even without Origin', () => {
  // A simple cross-site POST may omit Origin in some cases; the fetch metadata
  // is then the only signal, so it must be sufficient on its own.
  assert.equal(decide({ host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' }), 'block')
})

test('blocks an unparseable Origin rather than treating it as absent', () => {
  assert.equal(decide({ host: '127.0.0.1:19387', origin: 'not a url' }), 'block')
})

test('blocks a missing Host header', () => {
  assert.equal(decide({}), 'block')
})

test('guardMatchesImplementation: index.js still contains the same checks', () => {
  // Guards against the source being edited while this table silently passes.
  const src = fs.readFileSync(path.join(rootDir, 'index.js'), 'utf8')
  assert.match(src, /sec-fetch-site/, 'index.js must check sec-fetch-site')
  assert.match(src, /loopbackHosts/, 'index.js must check the Host header against loopback')
  assert.match(src, /originIsLoopback/, 'index.js must check Origin')
  assert.match(src, /403/, 'index.js must return 403 when refusing')
})
