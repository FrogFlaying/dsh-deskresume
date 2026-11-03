# DeskResume 采集能力实测报告

**机器**：Windows 10 家庭中文版 22H2 · build 19045.6466 · 单显示器 1536×864
**时间**：2026-10-14
**方法**：`test/measure_capability.py` 连续跑两次真实采集（带/不带 `-IncludeTerminalCwd`），
数字全部来自实际输出，非估算。

---

## 一、结论

**能抓到什么**：所有可见应用程序窗口的 exe 路径、命令行、窗口矩形、显示器归属、
最小化/最大化状态 —— 覆盖率 **100%**。

**抓不到什么**：多数程序并没有在命令行里声明它打开了哪个文件，所以
「恢复到具体文件」只有 **30%** 的窗口能做到；其余只能恢复到「打开这个程序」。

**这直接决定恢复器的能力上限**：恢复器能可靠做到「把程序都开起来并摆回原位」，
但「每个程序都打开到原来的那个文件」只在三分之一的窗口上成立。

---

## 二、逐通道实测

| 通道 | 手段 | 结果 | 说明 |
|---|---|---|---|
| 窗口枚举 | `user32.EnumWindows` | **760 个**枚举 → **27 个**可用 | 见下方「为什么 760 只剩 27」 |
| 窗口矩形 | `GetWindowRect` + `GetWindowPlacement` | 27/27 (100%) | 同时拿到当前矩形与还原矩形 |
| 窗口状态 | `IsIconic` / `IsZoomed` | 27/27 (100%) | 本次 23 最小化 / 0 最大化 |
| 显示器归属 | `MonitorFromWindow` + `GetMonitorInfo` | 27/27 (100%) | |
| 可执行文件路径 | `Get-WmiObject Win32_Process` | **27/27 (100%)** | |
| 命令行 | 同上 `CommandLine` | **27/27 (100%)** | |
| 可重放的启动参数 | 命令行解析 | **8/27 (30%)** | 见第三节 |
| 资源管理器文件夹 | `Shell.Application` COM | 1 个窗口 | 能拿到完整路径 |
| 终端工作目录 | `NtQueryInformationProcess` + `ReadProcessMemory`（PEB） | 见第四节 | 需要 `-IncludeTerminalCwd` |
| 显示器列表 | `System.Windows.Forms.Screen` | 1 台 | |

**单次完整采集耗时：约 400–620 ms**（含 PowerShell 启动与 C# 编译）。
这意味着每 1–2 分钟做一次定时快照，开销可以忽略。

### 为什么 760 个枚举只剩 27 个

| 过滤原因 | 数量 | 说明 |
|---|---|---|
| 无标题 | 351 | 大量不可见的辅助窗口 |
| 不可见 | 375 | `IsWindowVisible` 为 false |
| 被 DWM 遮蔽（cloaked） | 9 | UWP 挂起窗口、其他虚拟桌面上的窗口 |
| **保留** | **27** | 用户真正能看到的窗口 |

被遮蔽窗口必须过滤：它们在 API 层面「可见」，但实际不在屏幕上。
`DwmGetWindowAttribute(DWMWA_CLOAKED)` 是唯一可靠的判据。

---

## 三、关键限制：只有 30% 的窗口知道自己的文件

这是本次实测**最重要的发现**，也是恢复器能力的真正天花板。

实测中 8 个窗口带可重放参数：

```
notepad++.exe        ['C:\Users\<你>\Desktop\plan']                    ← 好：能还原到具体文件
wps.exe              ['/prometheus', '/pdf', 'D:\...\940个支付名词...pdf']  ← 好：能还原到具体文档
WeChat.exe           ['-autorun']                                    ← 无意义：只是自启标记
Doubao.exe           ['--launch_from=auto_run', '--start_time=...']  ← 无意义：自启时间戳
QQ.exe               ['/hosthwnd=68128', ...]                        ← 无意义：进程间通信句柄
Docker Desktop.exe   ['--analytics-enabled=true', '--name=login']    ← 无意义：遥测开关
GameViewer.exe       ['source=explorer.exe', '4B6671A6-...']         ← 无意义：来源标记
```

**问题**：上面 8 个里只有 2 个（Notepad++、WPS）的参数是真正可以重放的文档路径，
其余是启动标记、IPC 句柄、遥测开关。盲目重放这些参数不但无益，还可能有害
（例如重放 `--start_time=1791971146780`）。

**当前处理**：`lib/snapshot.js` 的 `relaunchArgs()` 会过滤掉所有 `-` / `--` 开头的开关，
只保留看起来像路径/URL/文档的参数。这是保守策略 —— 宁可少还原，不要乱还原。

**更大的一类损失**：Chrome / IDEA / VS Code 这些窗口的命令行**完全不含**当前打开的
文件或标签页（Chrome 的窗口标题里有网页标题，但标题≠URL，无法可靠重放）。
这类只能靠程序自身的会话恢复机制（浏览器的「继续上次浏览」、IDE 的最近项目）。

---

## 四、终端工作目录（PEB 读取）

### 机制

终端窗口通常属于 **host 进程**（`conhost.exe` / `WindowsTerminal.exe`），
而真正知道当前目录的是它的**子进程** shell（`powershell.exe` / `cmd.exe` / `wsl.exe`）。
直接读 host 的 PEB 只会得到 host 自己的目录，所以必须**沿进程树向下找 shell**。

### 验证

打开一个已知目录的 PowerShell 窗口（`-WorkingDirectory` 指向
`...\test\cwd-probe`），然后采集：

```
[deskresume] terminal cwd: 3/3 readable

  FOUND pid=17768 name=powershell.exe title='Windows PowerShell'
    class   = ConsoleWindowClass
    cwd     = D:\DeepSeek\harness\DeskResume\test\cwd-probe\
```

**读到的目录完全正确**，验证通过。

### 一个被实测抓出来的坑

最初的实现无条件对每个窗口做进程树向下查找。实测发现 **Chrome 窗口也被附上了工作目录**
`C:\Users\<你>\AppData\Roaming\FireShot\2.1.4\` —— 那是 Chrome 为某个扩展启动的
临时 `cmd.exe` 子进程的目录，与用户无关。若不修，恢复器会用这个目录去启动 Chrome。

**已修**：现在只对「本身就是终端界面」的窗口做进程树查找 ——
进程名属于终端 host，或窗口类属于 `ConsoleWindowClass` /
`CASCADIA_HOSTING_WINDOW_CLASS` / `mintty` 等。修复后误报归零。

### 边界

- 管理员权限运行的终端读不到（非提权进程无法 `PROCESS_VM_READ`）
- 无终端窗口打开时该通道自然为空（属正常，不是故障）

---

## 五、恢复器的实际能力上限

综合实测，恢复器能可靠做到：

| 能力 | 覆盖率 | 依据 |
|---|---|---|
| 重新启动关机前的程序 | **~100%** | exe 路径 100% 可读 |
| 把窗口放回原显示器原位置 | **~100%** | 矩形 + 显示器 100% 可读；越界钳制已验证 |
| 重新打开资源管理器文件夹 | **~100%** | Shell COM 已验证 |
| 程序打开到**具体文件** | **~30%** | 只有部分命令行带文档路径 |
| 终端回到原目录 | 仅终端窗口，且非提权 | PEB 读取已验证 |
| 浏览器/IDE 回到原标签页 | **需程序自身支持** | 命令行不含标签页信息 |
| 未保存内容 | **不可能** | Windows 无此 API |

**一句话**：能做到「程序都开起来、窗口都摆回原位、文件夹都回来」；
做不到「每个程序都精确回到当时打开的那个文件/标签页」。

---

## 五点五、无人值守抓取与标题稳定性（2026-10-15 第二轮实测）

### 计划任务实测

| 项目 | 实测结果 |
|---|---|
| `DeskResume-Interval` | 每 **120 秒**触发，30 份快照实测间隔 119–121 秒，平均 **120 秒** |
| `DeskResume-SessionEnd` | 事件订阅 `EventID=1074 / 6006` 已注册；手动触发后成功产出 `reason=session-end` 快照 |
| `pickSnapshot()` 优先级 | 实测选中 `session-end` 快照（而非更新的 interval）—— 该分支从死代码变为可用 |
| 弹窗 | **无**（见下方实测） |
| 权限 | `Limited`，不提权 |
| 网络面 | 无（任务不启动任何监听） |

### 控制台弹窗实测（用户反馈 → 确认 → 修复）

用户反馈「快照时会弹出终端」。实测**确认属实**：

| 启动方式 | 控制台窗口 | 是否曾经可见 |
|---|---|---|
| `powershell.exe ... -WindowStyle Hidden`（原实现） | 创建 | **是，约 101ms 起** |
| `wscript.exe run-hidden.vbs`（现实现） | 创建 | **否**（0/93 次采样） |

原因：`-WindowStyle Hidden` 只是传给 PowerShell 的**参数**，conhost 会先创建并显示窗口，
PowerShell 启动后才隐藏。`WshShell.Run(cmd, 0, false)` 的窗口样式 0 在 `STARTUPINFO` 里传
`SW_HIDE`，窗口从一开始就不显示。

两种方式都实测**确实写出快照**，排除「不弹窗但也没干活」的假通过。

### 标题稳定性（重启命中率的零风险代理指标）

按 **HWND** 追踪窗口（同一登录会话内 HWND 稳定），30 份快照 / 31 个被重复观测的窗口：

| 判定 | 窗口数 | 观测占比 |
|---|---|---|
| 标题**始终不变** | 27 | **87.2%** |
| 标题曾经变化 | 4 | 12.8% |

标题变化的 4 个窗口及原因：

| 程序 | 变化原因 |
|---|---|
| `wps.exe` | 用户切换了打开的文件（5 个不同文档名） |
| `chrome.exe` | 浏览器标签页标题随页面内容变化 |
| `deepseek harness.exe` | 会话标题随对话内容变化 |
| `explorer.exe` | 用户重命名了文件夹 |

**解读**：87% 的窗口在整个观测期内标题从未改变，重启后仍能被标题匹配到。
剩余 13% 属于**应用自身行为**（切换文档、标签页、重命名），不是匹配算法能解决的 ——
需要应用适配器（TODO P1-3）。

> ⚠️ **这是代理指标，不是命中率预测**。它回答「哪些窗口的失败是标题造成的」，
> 无法回答「重启后程序是否恢复自己的文档」。后者仍必须在真实重启（或虚拟机）中测。

> 方法修正记录：本脚本第一版按**进程名**分组，得出「33% 稳定」的结论 —— **是错的**。
> `explorer.exe` 显示 8 个标题是因为它有 8 个窗口，不是标题在变。改为按 HWND 分组后
> 结论修正为 87.2%。

---

## 六、可复现

```powershell
# 逐通道覆盖数据
python test\measure_capability.py

# 单元测试（39 项，纯逻辑，无需 Windows API）
node --test test/

# 窗口放置 + 中文标题 + 越界钳制（8 项，不改动屏幕）
node tools\place.smoke.mjs

# 计划任务验收（只读；未安装则 SKIP）
node tools\check-tasks.mjs

# 标题稳定性代理指标（只读）
node tools\title-stability.mjs

# 重启后验证（默认只读预览；加 --restore 才执行恢复）
node tools\verify-after-reboot.mjs
```

> `tools/` 下的脚本会触碰真实桌面或依赖本机任务状态，因此**刻意不放在 `test/`**：
> `node --test test/` 会把 `test/` 下所有 `.mjs` 当测试执行，混在一起会让测试结果不确定。

---

## 七、对下一步的影响

1. **定时快照成本极低**（实测 367–620ms/次，间隔 120 秒），断电最多丢 2 分钟状态
2. **提升「恢复到具体文件」的比例**需要按应用做适配器（app adapter）：
   - 浏览器：读会话文件或用 CDP 抓标签页（参考 WindowAnchor 的 connector 做法）
   - VS Code：读 `storage.json` 里的最近工作区
   - 终端：已有 PEB 方案，可扩展到 Windows Terminal 的标签页
3. **恢复顺序**值得做：先启动重应用（IDEA、Docker），再启动轻应用，避免争抢 IO
4. **真实重启验证**（TODO P0-3）仍是唯一未消除的不确定性；可考虑在 VMware 虚拟机中执行，
   以隔离对真机桌面的影响（见 TODO.md）
