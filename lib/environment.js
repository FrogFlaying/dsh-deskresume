/**
 * DeskResume — environment self-check.
 *
 * Every capability of this plugin is a Windows API reached through Windows
 * PowerShell: `user32.dll` for window enumeration and placement, WMI for command
 * lines, `Shell.Application` for Explorer folders, `explorer.exe` for reopening
 * them. There is no abstraction layer underneath, and there deliberately is not:
 * a cross-platform rewrite would be a different project.
 *
 * What was missing was the *statement* of that. On macOS the plugin loaded fine
 * (nothing gates on platform), listed zero snapshots, and a capture failed with
 * `spawn powershell.exe ENOENT` — a message that tells the user nothing about
 * whether they installed something wrong or picked the wrong machine. The check
 * below turns that into a sentence a person can act on.
 *
 * It is a pure observation: it never spawns anything, never changes state, and
 * never throws. A caller that ignores `ok` simply gets the old behaviour.
 *
 * @module lib/environment.js
 */

import fs from 'node:fs'
import os from 'node:os'

import { POWERSHELL } from './collector.js'

/** Windows 10 RTM is build 10240; everything before it is out of scope. */
const WIN10_BUILD = 10240

/**
 * Inspect the host.
 *
 * @returns {{
 *   ok: boolean,
 *   platform: string,
 *   problems: Array<{code: string, message: string, hint?: string}>,
 *   facts: {windows: boolean, build: number|null, release: string, powershell: string|null}
 * }}
 */
export function checkEnvironment() {
  const platform = process.platform
  const problems = []
  const windows = platform === 'win32'

  // os.release() on Windows is "10.0.19045" — the third component is the build.
  const release = String(os.release() ?? '')
  const buildPart = release.split('.').map(n => Number(n)).filter(n => Number.isFinite(n))
  const build = windows && buildPart.length >= 3 ? buildPart[2] : null

  let powershell = null
  if (windows) {
    try {
      powershell = fs.existsSync(POWERSHELL) ? POWERSHELL : null
    } catch { powershell = null }
  }

  if (!windows) {
    problems.push({
      code: 'not-windows',
      message: '桌面续开只在 Windows 上可用，当前系统是 ' + (platform === 'darwin' ? 'macOS' : platform) + '。',
      hint: '恢复功能依赖 Windows 专有接口（user32.dll 的窗口枚举与定位、WMI 的命令行、' +
        'Shell.Application 的资源管理器路径、explorer.exe）。macOS/Linux 需要另做一套实现' +
        '（NSWorkspace + 辅助功能 API），不是配置能打开的东西。',
    })
  } else if (!powershell) {
    problems.push({
      code: 'no-powershell',
      message: `找不到 Windows PowerShell（期望路径 ${POWERSHELL}）。`,
      hint: '采集与定位脚本都用 PowerShell 5.1 运行。请在“启用或关闭 Windows 功能”里确认 ' +
        'Windows PowerShell 2.0 引擎/Windows PowerShell 已安装，或安装 WMF 5.1 后重试。',
    })
  }

  if (windows && build !== null && build < WIN10_BUILD) {
    problems.push({
      code: 'too-old-windows',
      message: `Windows 版本过旧（build ${build}），本插件要求 Windows 10 (build ${WIN10_BUILD}) 或更高。`,
      hint: 'Windows 7/8/8.1 上连 DeepSeek Harness 本体都跑不起来（现代 Electron 已不支持），' +
        '所以这不是插件能兼容的范围。',
    })
  }

  return {
    ok: problems.length === 0,
    platform,
    problems,
    facts: { windows, build, release, powershell },
  }
}

/**
 * A one-line, user-facing description of why the host cannot be used.
 * Callers put this straight into tool output or an HTTP error.
 */
export function describeEnvironmentProblem(env) {
  if (env.ok) return ''
  const lines = []
  for (const p of env.problems) {
    lines.push(p.message)
    if (p.hint) lines.push(p.hint)
  }
  return lines.join('\n')
}

/** The same check, as a thrown Error — for call sites that cannot branch. */
export function assertSupportedEnvironment() {
  const env = checkEnvironment()
  if (!env.ok) {
    const error = new Error(describeEnvironmentProblem(env))
    error.code = 'unsupported-environment'
    error.environment = env
    throw error
  }
  return env
}

/**
 * Format the fact sheet shown in the Settings page footer. Kept here so the host
 * and the browser half agree on what "supported" looks like.
 */
export function describeEnvironment(env) {
  if (!env) return ''
  const bits = []
  bits.push(env.facts.windows ? 'Windows' : env.platform)
  if (env.facts.build) bits.push(`build ${env.facts.build}`)
  bits.push(env.facts.powershell ? 'PowerShell 可用' : 'PowerShell 不可用')
  return bits.join(' · ')
}
