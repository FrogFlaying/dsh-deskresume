# 「重启/关机后一键恢复桌面程序」调研报告

调研时间：2026-10-14 ｜ 目标平台：Windows ｜ 本机：Windows 10 Home China 22H2 (19045.6466)

> 说明：本次会话的 `web_search` 与 `web_fetch` 工具被本机网络出口（伪 IP 代理）阻断，
> 报告中的事实均来自本机 Python 直连抓取（GitHub API / raw README / Microsoft Learn /
> shields.io / 厂商官网）与注册表实测。凡未能直接抓到原文的条目，已标注「未直连验证」。

---

## 一、结论速览

你的需求可以拆成三件不同的事，市面上的工具分别只做好了其中一两件：

| 能力 | 含义 | 现有覆盖情况 |
|---|---|---|
| A. 启动一组程序 | 一键打开固定的几个程序 | 已解决，工具很多（Taskbar Groups、OpenMyDear 等） |
| B. 恢复窗口位置/尺寸 | 程序回到原来的显示器和坐标 | 已解决（PersistentWindows、WindowResizer 等） |
| C. 恢复「关机那一刻的真实状态」 | 自动抓取快照 + 自动重启后恢复 + 文件/文件夹/标签页 | **只有两三个很不成熟的项目在做，且都不是 Windows 10 的成熟方案** |

**所以：市面上没有一款成熟、广泛使用、能完整满足你需求的工具。**
最接近的是两个「个人新项目」和一个「13 星但功能最全」的项目，见下文 2.3 / 2.4 / 2.5。
自己做一个 DSH 插件是有真实空白的，但要清楚它属于「补最后一块拼图」而不是「从零发明」。

---

## 二、现有方案清单

### 2.1 系统自带（免费，但都不够）

**Windows 11「重启应用」**
设置 → 账户 → 登录选项 → 「重启应用」：「自动保存我的可重启应用，并在重新登录时重启它们」。
- 依赖应用自己调用 `RegisterApplicationRestart` API 主动注册（[MS 文档](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-registerapplicationrestart)），**没注册的程序不会被恢复**。
- 重启由系统在关机流程中用 `EWX_RESTARTAPPS` 标志触发（[ExitWindowsEx 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-exitwindowsex)）。
- 只恢复「程序」，不恢复未保存内容；且**仅 Windows 11 有**。
- ⚠️ 你的机器是 **Windows 10 22H2，本机 `HKCU\...\Winlogon\RestartApps` 不存在**，这个选项你用不了。
- 备注：该功能存在性为业内共识，但本次未能直连抓到官方帮助页原文（support.microsoft.com 相关链接均 404），**未直连验证**。

**文件资源管理器「登录时还原上一个文件夹窗口」**
文件夹选项 → 查看 → 登录时还原上一个文件夹窗口（注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced\PersistBrowsers`，本机实测该值**未设置**，即未开启）。
只能还原资源管理器窗口，覆盖不了其他程序。

**快速启动 / 休眠（hiberboot）**
「关机」时混合关机保留内核会话，但用户态程序仍会关闭，不满足需求。

---

### 2.2 一键启动程序组（只解决 A，不恢复状态）

| 工具 | 链接 | 星标 | 说明 |
|---|---|---|---|
| **PowerToys Workspaces** | [learn.microsoft.com/.../powertoys/workspaces](https://learn.microsoft.com/en-us/windows/powertoys/workspaces) ／ [github.com/microsoft/PowerToys](https://github.com/microsoft/PowerToys) | 139k | 微软官方。`Win+Ctrl+\`` 打开编辑器 → 捕获当前桌面布局 → 保存为 workspace → 生成桌面快捷方式一键启动，可为每个应用配 CLI 参数（如 VS Code 打开指定文件、Terminal 指定 profile）。**缺点：必须手动捕获，不会在关机前自动抓；不能恢复标签页/未保存内容；官方 FAQ 明确说无法让应用直接启动到指定位置，只能「先启动再搬窗口」，所以会看到窗口跳一下；管理员权限启动的应用无法被重定位（官方已知问题）。** |
| **Taskbar Groups** | [github.com/tjackenpacken/taskbar-groups](https://github.com/tjackenpacken/taskbar-groups) | 2.8k | 任务栏上的快捷方式分组，点一下弹出分组。纯启动器，无状态恢复。 |
| **OpenMyDear** | [github.com/NHHoangTuan/open-my-dear](https://github.com/NHHoangTuan/open-my-dear) | 1 | C#/WPF/MIT。Profile 概念，支持并行/顺序启动、应用发现、混合 exe/文件夹/文件、深浅色、自启。 |
| **Shortflow** | [github.com/CodebyAhad/shortflow](https://github.com/CodebyAhad/shortflow) | 1 | 全局热键启动应用组。 |
| **Slaunch** | [github.com/kunquqin/Slaunch](https://github.com/kunquqin/Slaunch) | 0 | 按项目分组的快捷方式启动器。 |

这类工具的共同短板：**它们打开的是你「配置时」设定的东西，而不是你「关机前」实际打开的东西。**

---

### 2.3 恢复窗口位置/尺寸（只解决 B）

| 工具 | 链接 | 星标 | 说明 |
|---|---|---|---|
| **PersistentWindows** | [github.com/kangyu-california/PersistentWindows](https://github.com/kangyu-california/PersistentWindows) | 2.1k | 本项目里**最成熟**的一个（可 `winget install PersistentWindows`）。原本解决多显示器唤醒/插拔后窗口乱跑。支持把桌面布局手动捕获到磁盘（liteDB），**「closed windows can be restored to corresponding virtual desktop after PC reboot」**——即重启后把已关闭的窗口按记录放回原位；Z-order 快照、按显示器配置自动恢复、暂停/恢复、自动升级。**但它不负责「重新启动程序」**，它管的是窗口的位置记忆与回位；需要管理员权限才能处理提权窗口。 |
| **WindowResizer** | [github.com/caoyue/WindowResizer](https://github.com/caoyue/WindowResizer) | 251 | 热键保存/恢复窗口大小位置。最后发版 2023-12，已停滞。 |
| **WindowsLayoutSnapshot** | [github.com/adamsmith/WindowsLayoutSnapshot](https://github.com/adamsmith/WindowsLayoutSnapshot) | 243 | 记住并恢复窗口位置。无 release 产物。 |
| **WindowAnchor** | [github.com/marvintrvl/WindowAnchor](https://github.com/marvintrvl/WindowAnchor) | 13 | 见 2.4，它比这一档强得多。 |
| **DisplayFusion**（商业） | [displayfusion.com/Features](https://www.displayfusion.com/Features/) | — | 付费。**Window Position Profiles**（保存/加载窗口位置尺寸）+ **Triggers**（监听窗口创建、解锁、空闲等事件后执行命令/脚本），是把它拼成「自动恢复」的可行底座。 |

---

### 2.4 真正做「会话快照 + 重启后恢复」的项目（最接近你的需求）

这三个是本报告的重点，**建议优先试用/参考**：

#### ① Rewake（最贴近你的描述，但只支持 Win11）
- 链接：<https://github.com/Anurag-patil-26/Rewake-Windows>
- 状态：C# / WPF / .NET 9 / MIT ｜ ★2 ｜ 最新 `v1.0.0-beta.2`（2026-07-30），release 下载量 26
- 定位语：*"Your workspace, back the way you left it."*
- 功能（来自其 README）：
  - 托盘常驻，**每 2 分钟自动快照**，也可手动拍照；保留最近 30 次快照
  - 关机/断电后会保留一条 **「Last Session · BEFORE SHUTDOWN」** 置顶快照，重启后一键恢复
  - 恢复内容：应用程序、**终端（恢复到上次所在目录，多标签窗口按每个路径一个标签还原）**、文件资源管理器窗口
  - 恢复时逐个启动（间隔 0.7s，重应用 2s），把窗口移回保存的显示器位置，超出屏幕则钳制到最近显示器
  - 勾选式恢复（自己挑要恢复哪些）、进度卡片、深浅色主题、开机自启、Force relaunch
  - 数据全部本地 `%LOCALAPPDATA%\Rewake`，**无任何网络连接**
- 已知限制（README 自述）：
  - **要求 Windows 11 64 位 —— 你是 Windows 10，跑不了**
  - 管理员权限运行的终端会恢复到默认目录
  - 部分 Microsoft Store 应用无法重启，会被跳过
  - **无法恢复未保存的文档内容**（只能恢复窗口，不恢复内容）
  - 未签名，会触发 SmartScreen；AV 可能误报（因为它读取窗口标题/命令行）
- 技术参考价值高：MVVM 结构、`EnumWindows` 抓窗口、从 shell 进程 PEB 读终端工作目录、首次开机后把最新「重启前快照」钉住 —— 这些正是你要做的核心机制。

#### ② Session Saver（功能最完整，但很粗糙）
- 链接：<https://github.com/wimpyelio/session-saver>
- 状态：纯 PowerShell 5.1+ / MIT ｜ ★1 ｜ 无 release
- 功能（README 自述）：
  - **自动保存**：每 30 分钟一次，且在**注销/重启/关机时立即保存**（⚠️ README 自述此功能「仍在开发阶段」，建议手动点保存）
  - **登录后约 30 秒自动静默恢复**
  - 文件资源管理器窗口（含位置尺寸）、浏览器标签页（Chrome/Edge/Brave/Vivaldi/Opera/Firefox/Waterfox/LibreWolf，并抑制「恢复页面？」崩溃横幅）、**记事本（连未保存的文本都实时备份成带时间戳的 txt）**、**VS Code（恢复同一文件夹/工作区而非空白窗口）**、窗口几何（位置/尺寸/最大化/最小化）
  - 桌面两个快捷方式：「Save Session Now」/「Restore Session」
  - 安装：`INSTALL.bat` 自提权 + 注册 3 个计划任务（`\SessionRestore\`）；支持 **Windows 7 SP1 ~ 11**
  - 单文件 JSON 快照，零依赖，无云无遥测
- 实现方式：`SessionSave.ps1` 扫进程可见窗口 → 取 exe 路径/标题/位置/状态，用 `Shell.Application` COM 查资源管理器，用 CIM 读命令行参数；`SessionRestore.ps1` 重启进程后用 `user32.dll` 摆窗口，并改写浏览器 `Preferences` 抑制崩溃提示。
- 风险：★1、无 release、README 自己承认自动保存未完成。**适合作为「实现思路与脚本模板」参考，不适合直接托付生产。**

#### ③ WindowAnchor（工程完成度最高的一个，功能也最全）
- 链接：<https://github.com/marvintrvl/WindowAnchor>
- 状态：C# / MIT ｜ ★13 ｜ 最新 `v1.7.0`（2026-09-29），release 下载 121
- 功能（README 自述）：
  - 跨多显示器 + **Windows 虚拟桌面**保存/恢复窗口；显示器几何变化时做「精确或自适应」的 DPI 感知回位
  - 重开受支持文档、文件夹、**VS Code 工作区**、**浏览器会话**、**资源管理器标签页**、**Windows Terminal 标签页**
  - 缺失的虚拟桌面会被重建，应用回到保存时的那个桌面
  - 恢复前对「模糊匹配」给出确认，同一个活动窗口不会被分配给两个条目
  - 可选恢复模式：Repair / Move Existing / Resume / Launch Fresh / Exact Switch / Preview Only
  - 恢复检查点 + 可撤销上一次破坏性切换；每条恢复项给出脱敏诊断结果
  - 托盘应用，可配热键与开机启动
  - 通过 app adapter 补齐 Windows 没有通用会话 API 的短板：Chromium 系浏览器与 PWA、Firefox、资源管理器、Windows Terminal、VS Code、ATLauncher、普通 Win32 程序
- 已知限制（README 自述）：Windows Terminal 不对外暴露每个标签的 profile 和当前目录，所以需要额外装一个 PowerShell prompt hook（`WindowAnchor-Terminal-Integration-<ver>.ps1`）才能完整恢复；Firefox/Chromium 需要装对应 connector 扩展。

#### ④ 其他同方向小项目（了解即可）
| 工具 | 链接 | 星标 | 说明 |
|---|---|---|---|
| Work Session Manager (WSM) | [akashthebro/work-session-manager](https://github.com/akashthebro/work-session-manager) | 1 | Python(Flask+pywin32+SQLite) + Electron/React。窗口位置尺寸状态、**插件化应用适配**（Chrome 标签经 CDP 抓取、VS Code 工作区）、捕获过滤器、恢复顺序、实时进度日志。设计思路值得参考。 |
| Folder Session Manager | [EternalShade3D/Folder-Session-Manager](https://github.com/EternalShade3D/Folder-Session-Manager) | 1 | 只做资源管理器窗口布局（路径/位置/尺寸/标签），PySide6，自动保存。 |
| workspace-switcher | [yMaxM15/workspace-switcher](https://github.com/yMaxM15/workspace-switcher) | 13 | 原生 Windows，热键快照/恢复多显示器窗口布局。无 release 产物。 |
| Session App | [goledica/Session-App](https://github.com/gololedica/Session-App) | — | Python+PySide6，自动化会话启动/工作流切换（仓库当前 404，**未直连验证**）。 |

---

### 2.5 Linux / macOS 侧（成熟得多，可借鉴设计）

| 工具 | 链接 | 星标 | 说明 |
|---|---|---|---|
| linux-window-session-manager | [johannesjo/linux-window-session-manager](https://github.com/johannesjo/linux-window-session-manager) | 444 | 保存/重载 X11 下打开窗口及位置。 |
| another-window-session-manager | [nlpsuge/gnome-shell-extension-another-window-session-manager](https://github.com/nlpsuge/gnome-shell-extension-another-window-session-manager) | 217 | GNOME 扩展，优雅关闭窗口并存为会话，开机恢复，支持 X11 与 Wayland。 |
| HopTab | [royalbhati/HopTab](https://github.com/royalbhati/HopTab) | 302 | macOS 工作区管理器：一键重排应用/窗口/布局，含快照、配置档、会话恢复。 |
| Smart Auto Move | [khimaros/smart-auto-move](https://github.com/khimaros/smart-auto-move) | 142 | 学习应用窗口尺寸位置，下次启动自动放回（支持 Wayland）。 |

**关键差距**：Linux/macOS 有窗口管理器层面的统一会话 API（或社区补齐的等价物），所以能做得很干净；**Windows 没有等价的通用「会话恢复」API**，这正是 Windows 侧工具都半成品的根因。

---

### 2.6 已停更/失效（避坑）

- **den4b TaskLayout**：曾能保存/恢复运行中程序的窗口位置。现 <https://www.den4b.com/products/tasklayout> 已 301 跳转到产品总览页，产品列表中**已无 TaskLayout**，可视为下架/停更。
- **WindowResizer**：2023-12 后无更新。
- **DockWin / WindowSaver**（AutoHotkey，★56 / ★37）：GitHub 显示 **archived**。

---

## 三、空白点分析（为什么值得自己做）

现有工具在以下任一处掉链子，而你的场景恰好全都要：

1. **自动抓取时机**：PowerToys Workspaces 要手动捕获；PersistentWindows 要手动 capture；只有 Rewake（2 分钟定时）和 Session Saver（30 分钟 + 关机事件）做到了「无感自动」。
2. **关机/断电前的那一次抓取**：只有 Rewake（保留 pinned「BEFORE SHUTDOWN」快照）和 Session Saver（关机事件触发）做了。**断电（非正常关机）场景下，定时快照的间隔直接决定你丢多少状态** —— 这里可以做得比它们好（比如监听 `WM_QUERYENDSESSION`/`WM_ENDSESSION` 并额外做高频轻量快照）。
3. **Windows 10 支持**：Rewake 直接要求 Win11；WindowAnchor 未声明 Win10 兼容性。**你的机器是 Win10 22H2，这是一个明确的空位。**
4. **文件/文件夹/标签页的还原深度**：只有 WindowAnchor 和 Session Saver 认真做了（Explorer 标签、Terminal 标签、浏览器会话、VS Code 工作区、记事本未保存文本）。PowerToys 明确不做。
5. **和 DSH 集成**：目前**没有任何一款工具是 DSH 插件**。如果做成 `dsh-*` 插件，可以顺手拿到你在 DSH 里的工作区/会话上下文，做「一键恢复 DSH 工作现场 + 桌面程序」的组合，这是别人没有的。
6. **无人做「恢复方案可编辑」**：恢复后你想删掉某几个、想让它下次别再开、想区分「工作/娱乐」两套快照 —— 目前要么没有，要么很弱。

---

## 四、建议的产品形态

建议做 **DSH 插件为主 + 一个常驻小进程为辅** 的组合（纯插件做不到关机前抓取，因为插件只在 DSH 运行时活着）：

```
dsh-<name>                        插件：UI、快照管理、一键恢复、与 DSH 会话联动
  └─ 依赖 host 侧常驻采集器        开机自启的轻量进程/计划任务：
       ├─ 定时快照（如每 60~120s，只写 diff，控制开销）
       ├─ 监听会话结束（WM_QUERYENDSESSION / WM_ENDSESSION）+ 注销/关机/重启事件 → 抓「关机前快照」
       └─ 监听系统启动 → 标记「上次是异常断电」→ 恢复时提示
```

核心抓取项（按价值排序）：
1. 顶层窗口：进程 exe 路径 + 窗口标题 + 窗口矩形 + 显示器归属 + 最小化/最大化状态 + 虚拟桌面
2. 启动参数：从进程命令行（CIM `Win32_Process.CommandLine`）拿到打开的文件/文件夹/URL
3. 资源管理器：用 `Shell.Application` COM 取所有窗口路径 + 标签页
4. 终端：从 shell 进程 PEB 读当前工作目录（Rewake 的做法）；Windows Terminal 需额外 hook
5. 浏览器：优先让浏览器自己恢复（置 `PersistBrowsers` / 会话策略），必要时用 CDP 抓标签页
6. 未保存内容：记事本可实时备份文本（Session Saver 的做法）；其他应用只能依赖其自身自动恢复

恢复策略：逐个启动 + 按保存顺序/用户自定义顺序 + 延迟重定位 + 重定位失败则退化为「不摆位置但保证启动」。

必须接受的边界（写进产品说明，别过度承诺）：
- **未保存的文档内容无法凭空恢复**，除非应用自己有自动恢复机制
- 管理员权限进程的窗口无法被非提权程序重定位（PersistentWindows / Rewake / PowerToys 都栽在这）
- 单实例应用（如「设置」）无法开第二个窗口，只能重定位已有窗口
- 显示器拔掉后原坐标失效，需要钳制到最近可用显示器

---

## 五、命名建议

### 首选：**DeskResume**（简称 **DR**）

- npm 包名 `deskresume`：**未被占用**（实测 registry 返回 404）
- GitHub 仓库搜索 `deskresume`：**0 个结果**（无同名项目）
- 语义直白：Desk（桌面）+ Resume（恢复/继续），一句话能说清
- DSH 插件包名自然衔接：`dsh-deskresume`；CLI/可执行名：`deskresume` / `dr`
- 中文可用名：**桌面续开** / **桌面续接**

### 备选

| 名称 | 简称 | 可用性（本次实测） | 说明 |
|---|---|---|---|
| **DeskReentry** | DR | npm 空闲；GitHub 0 结果 | 强调「重新进入工作现场」，但 reentry 有航天再入的联想，GitHub 上 `reentry` 已有 666 个仓库 |
| **DeskRevive** | DR | npm 空闲 | 强调「复活」，稍口语 |
| **Reawaken** | RW | npm 空闲 | 优雅，但偏文学、不易一眼懂 |
| **RelaunchPad** | RLP | npm 空闲 | 双关 launch pad，但容易被当成纯启动器（正是要避免的定位） |
| **SecondWind** | SW | npm **已占用**(0.3.2) | 「缓过一口气」，意境很好但名字有冲突 |
| **SessionKeeper** | SK | npm **已占用**(1.0.0) | 直白，但 npm 冲突且 GitHub 16 个同名 |
| **SnapRestore** | SR | npm 空闲，GitHub 8 个 | 描述准确但太泛 |

> ⚠️ **不要用 `Rewake`** —— 已被 [Anurag-patil-26/Rewake-Windows](https://github.com/Anurag-patil-26/Rewake-Windows) 占用，且它做的正是同一件事，会造成混淆。
> 也不建议 `SessionHarbor`：已有 [WangPeterXF/session-harbor](https://github.com/WangPeterXF/session-harbor)。

**最终建议**：项目名 **DeskResume**，简称 **DR**，DSH 插件包名 **`dsh-deskresume`**，中文名「桌面续开」。

---

## 六、下一步（待你确认后执行）

1. 确认命名 → 建仓 + 插件骨架（`package.json` 的 `dsh.bundle.patch` / `dsh.client` 结构可直接参照本机已有的 `dsh-desktop-organizer`）
2. 先做**只读的采集器原型**（枚举窗口 + 命令行 + Explorer 路径），验证在本机 Win10 22H2 上能抓到多少有效信息
3. 再做恢复器原型（逐个启动 + 重定位）
4. 最后接 DSH 插件 UI（快照列表 / 勾选 / 一键恢复）
