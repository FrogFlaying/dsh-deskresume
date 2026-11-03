/**
 * DeskResume — regression tests for relaunch-argument filtering.
 *
 * Every case below is a verbatim `args` array taken from a real snapshot on the
 * development machine. The old implementation filtered with a blacklist
 * (`startsWith('-')`), which these real applications defeated three different
 * ways, and the failure was silent: the restore simply replayed an IPC handle or
 * a telemetry switch as if the user had asked for it.
 *
 * These tests exist because the bug was found by hand, not by the suite. The
 * whitelist is what makes them pass; they are the reason it stays a whitelist.
 *
 * Run: node --test test/relaunch-args.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { relaunchArgs } from '../lib/snapshot.js'

test('drops a switch hidden behind a leading space (WeChat)', () => {
  // Real: "...WeChat.exe" --parent-log-prefix=MM " -sw0x00000000000405FC:1791977224185"
  // The argv element keeps its leading space, so startsWith('-') missed it.
  const args = ['--parent-log-prefix=MM', ' -sw0x00000000000405FC:1791977224185']
  assert.deepEqual(relaunchArgs({ args }), [])
})

test('drops slash-prefixed switches (QQ)', () => {
  const args = [
    '/hosthwnd=68128',
    '/hostname=QQ_IPC_{3BE8CB6F-9654-46C4-96F9-24558BAB97B1}',
    '/memoryid=0',
    'D:\\Program Files\\Tencent\\QQ\\Bin\\QQ.exe',
  ]
  // The trailing value is the app's own executable, which QQ passes back to
  // itself; replaying it is not something the user did.
  assert.deepEqual(relaunchArgs({ args, exe: 'D:\\Program Files\\Tencent\\QQ\\Bin\\QQ.exe' }), [])
})

test('drops key=value markers and bare identifiers (GameViewer)', () => {
  const args = ['source=explorer.exe', '4B6671A6-B8EA-4597-A9B7-3EFA8575855F']
  assert.deepEqual(relaunchArgs({ args }), [])
})

test('drops telemetry switches (Doubao)', () => {
  const args = ['--launch_from=auto_run', '--start_time=1791971146780']
  assert.deepEqual(relaunchArgs({ args }), [])
})

test('keeps a real document path (Notepad++)', () => {
  const args = ['C:\\Users\\someone\\Desktop\\plan']
  assert.deepEqual(relaunchArgs({ args }), ['C:\\Users\\someone\\Desktop\\plan'])
})

test('keeps the document but drops the switches around it (WPS Office)', () => {
  const doc = 'D:\\Users\\someone\\Documents\\940个支付名词大全.pdf'
  const args = ['/prometheus', '/pdf', doc]
  assert.deepEqual(relaunchArgs({ args }), [doc])
})

test('keeps a URL argument', () => {
  const args = ['https://example.com/page', '--new-window']
  assert.deepEqual(relaunchArgs({ args }), ['https://example.com/page'])
})

test('keeps a UNC path', () => {
  const args = ['\\\\server\\share\\doc.txt']
  assert.deepEqual(relaunchArgs({ args }), ['\\\\server\\share\\doc.txt'])
})

test('unwraps a quoted path argument', () => {
  const args = ['"D:\\my docs\\a b.txt"']
  assert.deepEqual(relaunchArgs({ args }), ['D:\\my docs\\a b.txt'])
})

test('refuses to relaunch a Chromium helper process', () => {
  const args = ['--type=renderer', '--user-data-dir=C:\\x']
  assert.deepEqual(relaunchArgs({ args }), [])
})

test('returns an empty list for no arguments', () => {
  assert.deepEqual(relaunchArgs({ args: [] }), [])
  assert.deepEqual(relaunchArgs({}), [])
})

test('never returns a non-path token, whatever its shape', () => {
  // The whitelist's whole point: unknown switch shapes are dropped by default
  // rather than replayed. Anything that is not a path or URL must vanish.
  const hostile = [
    '--anything=1', '-x', '/switch', 'bare', 'a=b',
    '=weird', '--', '-', '/', '..', '.', 'C:', '   ',
    'source=explorer.exe', '1791971146780',
  ]
  assert.deepEqual(relaunchArgs({ args: hostile }), [])
})
