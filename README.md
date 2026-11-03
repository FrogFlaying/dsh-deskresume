# DeskResume

**桌面续开** — 重启或断电后，一键恢复关机前打开的程序、文件和文件夹。

- 项目名 **DeskResume**，简称 **DR**
- DSH 插件包名 `dsh-deskresume`
- 目标平台：Windows（已在 **Windows 10 22H2 / build 19045.6466** 实测）

> 状态：**采集器、放置器、恢复器、插件骨架、无人值守计划任务均已实现并通过测试。**
> 唯一未完成的是**真实重启场景验证**（恢复器从未在真重启后跑过，标题匹配命中率未知）。
> 采集能力实测结果见 [docs/capability-report.md](docs/capability-report.md)。

---

## 它解决什么

你的使用习惯是：桌面上开一堆程序，然后被迫重启、或待机没电关机；开机后要一个个手动重新打开。
DeskResume 做三件事：

1. **定时/关机前自动快照**当前桌面状态（开了哪些程序、每个程序打开了什么文件/文件夹、窗口在哪个显示器什么位置）
2. **一键恢复**：重新启动那些程序（带着它们原来打开的文件）、重新打开资源管理器文件夹、把窗口放回原来的位置
3. 全部数据留在本机，**不联网**

## 为什么是「插件 + 常驻采集器」两层

纯 DSH 插件做不到关机前抓取 —— 插件只在 DSH 进程活着时运行，而关机时 DSH 已经退出了。
所以拆成两层：

| 层 | 负责 | 现状 |
|---|---|---|
| DSH 插件（`index.js` / `client.js`） | UI、快照列表、恢复方案预览、一键恢复、给 agent 提供 `deskresume` 工具 | **已完成** |
| 采集器（`collector/collect.ps1`） | 枚举窗口、读命令行、读资源管理器路径、读终端工作目录；只读 | **已完成并实测** |
| 放置器（`collector/place.ps1`） | 把窗口移回保存的位置，越界则钳制到最近显示器；标题+类名+显示器多因子匹配 | **已完成并实测** |
| 定时/关机事件（`collector/install-tasks.ps1`） | 定时快照 + 关机前抓取 | **已实现并实测**（interval 快照已由计划任务真实产出） |

> 定时与关机前抓取需要先注册计划任务，见下方「启用无人值守抓取」。
> 计划任务直接调用 `collect.ps1`，**不开放任何网络端口**。

---

## 目录结构

```
DeskResume/
├── index.js                 # DSH 插件 Host 半身：agent 工具 + HTTP API
├── client.js                # DSH 插件浏览器半身：设置页「桌面续开」
├── package.json             # 插件清单（dsh.bundle.patch / dsh.client）
├── cordis.patch.yml         # 插件挂载补丁
├── config/
│   └── deskresume.json      # 默认配置（可另建 deskresume.local.json 覆盖）
├── collector/
│   ├── collect.ps1          # 只读采集器（实测通过）
│   ├── place.ps1            # 窗口放置器（实测通过，回显请求 id）
│   ├── recent-docs.ps1      # 只读文档索引：Recent 快捷方式 + WPS 最近列表
│   ├── run-hidden.vbs       # 无窗口启动器（计划任务用它调采集器）
│   ├── install-tasks.ps1    # 注册定时/关机前抓取的计划任务
│   └── uninstall-tasks.ps1  # 移除计划任务（默认保留快照）
├── lib/
│   ├── snapshot.js          # 纯 Node：快照读取、校验、迁移、恢复方案生成
│   ├── config.js            # 配置解析（默认 → 本地覆盖 → 调用方覆盖）
│   ├── collector.js         # 调起采集器并解析结果
│   ├── restore.js           # 执行恢复：启动程序、打开推测文档、多轮放置（带并发锁）
│   ├── documents.js         # 多标签应用的文档推测（标题历史 + 最近文件反查）
│   ├── recent-index.js      # 文档索引的调用与缓存（15 分钟）
│   ├── reports.js           # 恢复报告落盘、保留、列表
│   └── environment.js       # 平台/PowerShell 自检
├── test/
│   ├── snapshot.test.mjs       # 快照/恢复方案单测（13 项，无需 Windows API）
│   ├── relaunch-args.test.mjs  # 启动参数过滤回归测试（12 项，来自真实快照）
│   ├── config.test.mjs         # 配置与 schema 迁移测试（11 项）
│   ├── documents.test.mjs      # 文档推测单测（17 项，标题来自真实快照）
│   ├── reports.test.mjs        # 恢复报告落盘/保留/越权读取（6 项）
│   ├── environment.test.mjs    # 环境自检（6 项）
│   ├── restore-rounds.test.mjs # 多轮定位/待登录/文档任务（8 项）
│   ├── restore-lock.test.mjs   # 恢复并发锁测试（5 项）
│   ├── placement-handoff.test.mjs     # 放置器请求交接回归测试（8 项，真实 place.ps1）
│   ├── client-restore-report.test.mjs # 设置页部分恢复报告测试（3 项）
│   ├── client-i18n.test.mjs           # 设置页语言测试（7 项）
│   ├── request-guard.test.mjs         # HTTP 请求守卫测试（7 项）
│   ├── measure_capability.py   # 采集能力实测脚本
│   └── register_workspace.py   # 把本项目注册进 DSH 工作区（一次性）
├── tools/                   # 需要真实桌面/系统的脚本，刻意不放 test/（避免被 --test 自动执行）
│   ├── tools/place.smoke.mjs         # 端到端冒烟测试（8 项，真实窗口，不改变屏幕）
│   ├── check-tasks.mjs         # 计划任务验收（只读；未安装则 SKIP）
│   └── verify-after-reboot.mjs # 重启后验证：默认只读预览，加 --restore 才执行
├── docs/
│   ├── session-restore-survey.md  # 同类工具调研报告
│   ├── name_check.txt             # 命名占用实测记录
│   └── capability-report.md       # 本机采集能力实测报告
└── data/                    # 快照存放处（snapshot-*.json，已 gitignore）
```

---

## 快速开始

### 1. 采集一个快照（只读，不改动任何东西）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File collector\collect.ps1 -Reason manual
```

加 `-IncludeTerminalCwd` 可额外读取终端的工作目录（走 PEB，需要能打开目标进程）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File collector\collect.ps1 -Reason manual -IncludeTerminalCwd
```

### 2. 看恢复方案（不启动任何程序）

```powershell
node -e "import('./lib/snapshot.js').then(async m => { const doc = m.readSnapshot(m.pickSnapshot('.')); console.log(m.planRestore(doc, { runningProcesses: [] })) })"
```

### 3. 跑测试

```powershell
node --test test/                     # 110 项：单元 + 放置器交接测试，可重复
node tools\place.smoke.mjs            # 真实窗口冒烟测试（8 项，不改变屏幕）
node tools\check-tasks.mjs            # 计划任务验收（只读；未安装则 SKIP）
```

> **在 DSH 沙箱里跑，`placement-handoff` 的 8 项会被跳过（不是失败）**：沙箱禁止
> 「子进程 + 管道 stdio」，而 `node --test test/` 每个测试文件都要起子进程，那一组还要
> 直接调 `place.ps1`。测试文件会先探测一次（`spawn EPERM`）并打印原因，然后跳过自己：
> 沙箱里 `102 通过 / 0 失败 / 8 跳过`，在**普通 PowerShell 窗口**里 `110 项全绿`。
> 中止进程起不来的情况下，`place.ps1` 的同一场景已用 PID/标题逐条人工核对过。
>
> **为什么集成脚本放在 `tools/` 而不是 `test/`**：`node --test test/` 会把 `test/` 下
> **所有** `.mjs` 当成测试文件执行，于是它也会跑冒烟测试（真实移动窗口）和计划任务验收
> （依赖本机任务状态）—— 结果是不确定、且"41 项通过"里混了 2 个非单元测试。
> 移出后单元测试稳定、可重复。
>
> `test/placement-handoff.test.mjs` 是例外：它**会**调真实的 `place.ps1`，但只喂不存在的
> 窗口标题，因此不移动任何窗口、结果完全确定，可以安全地留在 `test/` 里。

---

## 启用无人值守抓取（关键一步）

不做这一步，DeskResume 就只是个手动快照工具 —— 「断电后恢复」的能力完全依赖它。

```powershell
# 先看会注册什么，不动系统
powershell -NoProfile -ExecutionPolicy Bypass -File collector\install-tasks.ps1 -DryRun

# 真正注册
powershell -NoProfile -ExecutionPolicy Bypass -File collector\install-tasks.ps1

# 验证（只读）
node tools\check-tasks.mjs
```

注册两个计划任务：

| 任务 | 触发 | 作用 |
|---|---|---|
| `\DeskResume\DeskResume-Interval` | 每 `intervalSeconds` 秒（默认 600 = 10 分钟） | 定时快照，`reason=interval` |
| `\DeskResume\DeskResume-SessionEnd` | 系统事件 1074 / 6006 | 关机前抓取，`reason=session-end` |

要点：

- **不需要管理员权限**，任务以当前用户、`Limited` 级别运行（读取提权进程本来就不可能，静默提权反而是权限变更）
- **不开放任何网络端口** —— 计划任务直接调用 `collect.ps1`，因为计划任务运行在 DSH 之外，任何 HTTP 暴露都会绕过 DSH 的认证
- **不弹窗、不闪控制台** —— 任务通过 `run-hidden.vbs` 启动（见下）
- 间隔与保留数量读取 `config/deskresume.json`（`deskresume.local.json` 可覆盖），与插件保持一致
- 卸载：`powershell -File collector\uninstall-tasks.ps1`（默认**保留**快照，加 `-PurgeSnapshots` 才删除）

### 为什么计划任务走 `run-hidden.vbs` 而不是直接调 `powershell.exe`

**实测结论**：直接调用 `powershell.exe` 并加 `-WindowStyle Hidden` **仍会闪出控制台窗口**。

原因是 `-WindowStyle Hidden` 只是传给 PowerShell 的**参数**：conhost 会先把控制台窗口创建并显示出来，
PowerShell 启动后才把它隐藏。这段间隙实测约 **100ms**，每 2 分钟闪一次。

| 启动方式 | 控制台窗口 | 是否可见 |
|---|---|---|
| `powershell.exe ... -WindowStyle Hidden` | 创建 | **可见，约 101ms 起** |
| `wscript.exe run-hidden.vbs`（`WshShell.Run` 窗口样式 0） | 创建 | **从不**（0/93 次采样） |

`WshShell.Run` 的窗口样式 0 会在 `STARTUPINFO` 里传 `SW_HIDE`，窗口从一开始就不显示。
两种方式都已实测**确实写出快照**（避免"不弹窗但也没干活"的假通过）。

> 测量方法：以 3ms 间隔轮询 `ConsoleWindowClass` 窗口集合，
> 记录每个新建窗口是否**曾经**可见（不是只看某一瞬间），并暂停定时任务排除干扰。

---

## 配置

`config/deskresume.json` 是默认值；建 `config/deskresume.local.json` 可覆盖任意字段（该文件不会被提交）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `intervalSeconds` | 600 | 定时快照间隔（最小 15）。600 = 10 分钟 |
| `keepSnapshots` | 144 | 保留多少份快照，超出后自动删除最旧的 |
| `terminalCwd` | false | 是否读取终端工作目录（需打开目标进程） |
| `extraExcludedProcesses` | [] | 额外忽略的进程名 |
| `extraExcludedTitles` | [] | 额外忽略的窗口标题片段 |
| `launchDelayMs` / `heavyDelayMs` | 700 / 2000 | 恢复时的启动间隔（重应用额外等待） |
| `settleMs` | 3000 | 第一轮窗口定位前等多久 |
| `placeRetryMs` | `[12000, 30000]` | 之后每轮定位前再等多久（多轮重试） |
| `keepReports` | 50 | 保留多少份 `data/restore-*.json`（0 = 全留） |
| `inferDocuments` | true | 是否用快照历史推测多标签应用里的其余文档 |
| `inferDocumentsHours` | 24 | 回溯多久的标题历史 |
| `inferDocumentsLimit` | 8 | 每个应用最多推测打开几个文档 |
| `inferDocumentApps` | 见配置文件 | 允许推测文档的进程名（默认是办公/文档类） |

### 快照存在哪里

```
D:\DeepSeek\harness\DeskResume\data\snapshot-<日期>-<时间>-<原因>.json
```

例如 `snapshot-20261016-081338-interval.json`。

- **只存本机**，不联网、不上传
- 每份约 **44 KB**（实测，25–31 个窗口时）
- 已加入 `.gitignore`，**不会进版本库**（快照含真实窗口标题、命令行、文件夹路径）
- 同一份快照里包含：窗口列表（exe/标题/矩形/显示器/状态）、资源管理器文件夹、系统与屏幕信息

### 历史快照怎么处理

**按份数保留，不按时间**：每次采集后，采集器会把 `data/` 里的快照按时间倒序，
**只留最新 `keepSnapshots` 份，其余直接删除**（[collect.ps1:528](collector/collect.ps1#L528)）。

这意味着两件事：

| | 计算方式 | 当前值 |
|---|---|---|
| **能回溯多久** | `intervalSeconds × keepSnapshots` | 600 秒 × 144 = 86400 秒 = **24 小时** |
| **占多少磁盘** | `keepSnapshots × 44 KB` | 144 × 44 KB ≈ **6.2 MB** |

> ⚠️ **关键权衡**：磁盘占用由**份数**决定，**与间隔无关**。
> 所以调大间隔等于「同样的磁盘，换更长的历史」：
>
> | 间隔 | 份数 | 覆盖时长 | 占用 |
> |---|---|---|---|
> | 120 秒（2 分钟） | 30 | 3600 秒 = **1 小时** | 1.3 MB |
> | 600 秒（10 分钟） | 30 | 18000 秒 = **5 小时** | 1.3 MB |
> | 600 秒（10 分钟） | **144** | 86400 秒 = **24 小时** | **6.2 MB** |
>
> 想保留更久，调大 `keepSnapshots` 即可；每份约 44 KB，成本很低。

另外，**`reason=session-end` 的关机前快照不会因保留策略被优先删除**——
它和其他快照一样按时间参与清理，只要在最新 `keepSnapshots` 份里就会保留。
当前 24 小时覆盖意味着：关机后只要在 24 小时内回来，那份「关机前状态」还在。

---

## 恢复能到什么程度（实测边界）

### WPS 这类「一个窗口装多个文档」的应用

**现象**：重启后 WPS 只打开了关机前的一个文档，其余表格/文档没回来。

**原因**：`EnumWindows` 只能看到**顶层窗口**，而 WPS 默认把多个文档放在同一个窗口的
标签页里 —— 桌面层面永远只有 1 个窗口，标题只反映**当前标签**，进程命令行也只留着
**启动时传入的那一个文件**（后续双击文档是复用已有进程，不产生新命令行）。

**现在的处理**（`inferDocuments`，见 [lib/documents.js](lib/documents.js)）：

1. 从保留的快照历史里收集同一进程出现过的**所有不同标题**（间隔 600 秒 × 144 份 = 24 小时）；
2. 把标题还原成文件名（去掉 `[只读]`、`*`、` - WPS Office`）；
3. 用「最近打开文件」索引反查真实路径（`%APPDATA%\...\Recent\*.lnk` +
   WPS 自己的 `HKCU\Software\Kingsoft\Office\6.0\*\RecentFiles\Sequence`，
   由 [collector/recent-docs.ps1](collector/recent-docs.ps1) 生成，缓存 15 分钟）；
4. 恢复时对每个文档单独启动一次（等价于你双击那个文件）。

本机实测（2026-10-23 的关机前快照）：

```
wps.exe 命令行参数：940个支付名词大全….pdf          ← 只有一个
推测出 3 个文档：
  D:\文档\note\网络策略申请记录表.xlsx        （历史出现 80 次）
  D:\文档\数字化运营平台\项目储备库\需求\04-需求评审确认表.doc  （2 次）
  D:\文档\note\系统运维备忘录.xlsx            （8 次）
```

**这是推测，不是观测**：那段时间里「开过又关了」的文档也会被重新打开；而在两个快照点
之间切换过、从未停留到采集时刻的标签会漏掉。想关掉它：`inferDocuments: false`。

### QQ / 微信这类要登录的应用

**现象**：重启后聊天窗口没有回来。

**采集没问题**：聊天窗口在快照里是独立顶层窗口（QQ 的 `TXGuiFoundation`、
微信的 `WeChatMainWndForPC`），标题、位置、大小都在。

**恢复做不到的部分**（不是 bug）：

1. 没有任何命令行参数能「打开某个会话」。QQ 的 `/hosthwnd=` 是进程间 IPC 句柄、
   微信的 `" -sw0x…"` 是登录态句柄，都不是用户意图，白名单会丢弃它们；
2. 聊天窗口是**登录成功之后**由应用自己创建的。恢复只做「启动进程 + 按标题挪窗口」，
   而登录可能要扫码 10–30 秒。

**现在的处理**：定位分 3 轮（3 秒 / 15 秒 / 45 秒），登录类应用如果始终没有匹配窗口，
会被归到**「待登录」**而不是失败项。登录完成后执行一次「只重排窗口」
（`deskresume action="restore" launch=false`）即可把主窗口摆回原位 —— 不会重复启动程序，
也不会重开文档。

### 恢复报告

每次恢复都会写一份 `data/restore-<时间>.json`（保留 `keepReports` 份），内容包含：
来源快照、计划摘要（应用/标题/重放参数/推测文档，**不含窗口几何坐标**）、
每个阶段的结果、待登录项、失败项。

- agent：`deskresume action="reports"`
- HTTP：`GET /api/deskresume/reports`

这样「上次为什么 QQ 没回来」是可以事后查的，而不是只能看屏幕上滚过去的输出。

### 平台支持

| 系统 | 能跑吗 | 说明 |
|---|---|---|
| **Windows 10 / 11** | ✅ | 目标平台，本机 Win10 22H2 (19045) 实测通过 |
| Windows 7 / 8.1 | ❌ | DSH 本体是现代 Electron，从 Electron 23 起不支持 Win7/8.1；另外脚本要求 PowerShell 5.1（Win7 自带 2.0） |
| macOS / Linux | ❌ | 每个采集通道都是 Windows 独有（`user32.dll`、WMI、`Shell.Application` COM、`explorer.exe`、`tasklist`）；需要另写一套实现 |

插件现在会**先自检再动手**（[lib/environment.js](lib/environment.js)）：非 Windows 或找不到
PowerShell 时，`capture` / `restore` 直接返回一句可读的说明（`GET /api/deskresume/environment`
可查），设置页顶部也会显示提示 —— 而不是抛 `spawn powershell.exe ENOENT`。

Win11 上还有两处已知差异（未在本机验证，属于结构性的）：资源管理器从 22H2 起有标签页，
而 `Shell.Application` 按**窗口**枚举，一个窗口多个标签时通常只拿到当前标签的路径；
Win11 自带的「重启应用」可能和插件同时启动程序，插件会检测到已在运行而跳过，不会开两份。

---

## 在 DSH 里启用插件

安装会改动 profile 的 `package.json` / `cordis.patch.yml`，这两个文件由 Plugin Manager 管理：

```powershell
dsh plugin --profile desktop add D:\DeepSeek\harness\DeskResume
```

装完重启 DSH，设置页会出现「桌面续开」一节。agent 也可以直接调用 `deskresume` 工具：

```
deskresume action="capture"                      # 抓快照
deskresume action="list"                         # 看快照列表
deskresume action="plan"                         # 预览恢复方案（不动桌面）
deskresume action="restore"                      # 执行恢复
deskresume action="restore" launch=false         # 只重排窗口，不启动程序（登录后用这个）
deskresume action="reports"                      # 看历史恢复报告
```

> 安全约定：`restore` 之前先跑 `plan`。`plan` 完全只读。

### HTTP API 的访问控制

`/api/deskresume/*` 能启动程序、移动窗口，所以插件**自己**做了请求守卫：

| 请求特征 | 结果 |
|---|---|
| `Host` 为回环地址（`127.0.0.1` / `localhost` / `::1`） | 放行 |
| `Host` 为其他域名（DNS rebinding） | **403** |
| `Origin` 为跨站 | **403** |
| `Sec-Fetch-Site: cross-site` | **403** |

**为什么必须自己检查**：实测确认 DSH 的 web server **不会**拦截插件路由 ——
一个没有凭证、伪造了 `Host`、带跨站 `Origin` 与 `Sec-Fetch-Site: cross-site` 的请求
仍然能拿到 **200**。没有这层守卫，用户**只是访问一个网页**就可能被跨站 POST 到
`/capture` 或 `/restore`（后者会启动程序）。

另外，`file` 参数被**限制在快照目录内**：否则调用方可以自己写一份快照 JSON 指向任意 exe，
让 `restore` 去启动它 —— 那就等于任意程序执行。

> 这两项是**实测发现**的，不是推断。修复前已验证攻击确实成功（跨站 POST 写出了快照；
> 任意路径的快照让 `plan` 列出了攻击者指定的 exe）。

---

## 重启后怎么验证（照着做即可）

这一步只能由你在真实重启后完成 —— 开发环境无法模拟"重启后标题是否还一样"。
全程**不需要写代码**，复制粘贴命令即可。

### 准备（重启前，做一次）

确认定时快照在跑：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File collector\install-tasks.ps1 -DryRun
node tools\check-tasks.mjs
```

看到 `ALL PASS` 就行。然后**正常使用电脑**，至少 5 分钟（让定时快照攒下几份）。

### 第 1 步：重启前，记录现在开着什么

```powershell
cd D:\DeepSeek\harness\DeskResume
powershell -NoProfile -ExecutionPolicy Bypass -File collector\collect.ps1 -Reason manual
```

> 也可以直接截图记录当前桌面，人工对照更方便。

### 第 2 步：正常重启电脑

正常点「开始 → 电源 → 重启」。**不要**关掉任何程序，让它们留在那里。

### 第 3 步：重启后，先"看方案"（只读，不会动任何东西）

```powershell
cd D:\DeepSeek\harness\DeskResume
node tools\verify-after-reboot.mjs
```

这会打印一份**预览**：打算启动哪些程序、重开哪些文件夹、摆回哪些窗口。
**桌面完全不会变**，随便跑。

### 第 4 步：确认无误后，执行恢复

```powershell
node tools\verify-after-reboot.mjs --restore
```

它只会开你重启前本来就开着的那些程序。

### 第 5 步：把输出贴给我

把第 4 步输出的**全部内容**复制粘贴给我。里面会有一行：

```
  标题匹配命中率：23/26 = 88.5%
```

我据此更新 [docs/capability-report.md](docs/capability-report.md)。
结果同时会存到 `data/reboot-verify-*.json`（已 gitignore）。

> **担心乱动桌面**：第 3 步完全只读。第 4 步才会真的开程序。
> **看不懂输出**：不用看懂，整段贴给我即可。

---

## 必须接受的边界

这些不是「待修 bug」，是 Windows 的客观限制，已在代码里显式处理并写进输出：

| 边界 | DeskResume 的处理 |
|---|---|
| **未保存的文档内容无法恢复** | 只还原窗口，不还原内容；每次恢复都会明确提示 |
| **提权进程的窗口无法被非提权程序重定位** | 不做 UAC 提权；这类窗口列为 `manual` 并说明原因 |
| **单实例应用只能重定位** | 识别单实例程序，只切到前台，不尝试开第二个 |
| **显示器拔掉后原坐标失效** | 越界坐标钳制到最近的已连接显示器，并逐条报告 |
| **多标签窗口只暴露当前标签** | 用快照历史 + 最近文件索引**推测**其余文档并逐个打开，见上文 |
| **登录后才出现的窗口（QQ/微信）无法提前定位** | 定位分 3 轮；仍无窗口则列为「待登录」，登录后跑「只重排窗口」 |
| **聊天会话本身无法用命令行打开** | 如实列为待登录/失败，不假装恢复成功 |
| 管理员权限下运行的终端读不到工作目录 | 读不到就留空，不猜 |
| 部分 Microsoft Store 应用无法重启 | 启动失败会记进 `failed`，不静默吞掉 |
| **非 Windows 主机** | 环境自检直接说明原因，不启动任何东西 |

## 实现上的坑（已修，记录备查）

1. **PowerShell 5.1 按 ANSI 读取无 BOM 的 `.ps1`**，脚本里的中文会乱码导致语法错误。
   → 所有 `.ps1` 保持纯 ASCII，用户可见文案交给 Node 侧输出。
2. **PowerShell 5.1 通过管道 stdin 读取会用 OEM 代码页解码**，中文窗口标题会被破坏，
   导致按标题匹配窗口失败。
   → 采集器与放置器之间的 JSON 改走 **UTF-8 文件**（`-Json` / `-Out`），不走 stdio。
   `tools/place.smoke.mjs` 专门用中文标题窗口（`微信`）验证了这条。
3. **`Get-Content -Raw` 读无 BOM 的 JSON 配置同样走 ANSI**，`config/deskresume.json` 里的中文
   会被破坏成非法 JSON，安装脚本静默回退到默认值。
   → `install-tasks.ps1` 改用 `[System.IO.File]::ReadAllText($path, UTF8)`。
4. **`MSFT_TaskEventTrigger` 必须带 `-Namespace 'Root/Microsoft/Windows/TaskScheduler'`**，
   不带命名空间会静默返回 `$null`，导致关机前抓取的任务根本没注册却显示成功。
5. **本机没有 `Task:` PSDrive**，`New-Item -Path Task:\...` 会失败。
   → `Register-ScheduledTask` 自己会创建任务文件夹，不需要手工建。
6. **启动参数过滤不能用黑名单**。真实快照里微信用 `" -sw0x…"`（前导空格）、QQ 用 `/hosthwnd=`、
   GameViewer 用 `source=explorer.exe`，三种形态都能绕过 `startsWith('-')`。
   → 改为**白名单**：只有像绝对路径或 URL 的参数才会被重放，其余一律丢弃。

## 下一步

1. 把恢复器在**真实重启**场景再跑一遍，验证多轮定位与推测文档的命中率
2. 终端标签页/浏览器标签页的深度恢复（参考调研报告里的 WindowAnchor 做法）
3. 快照 diff 压缩（现在每次全量写，25 个窗口约 40KB；默认保留 144 份，约 6.2MB 上限）
4. Win11 实机验证：资源管理器标签页的路径枚举、与系统「重启应用」的并发

完整待办与优先级见 [TODO.md](TODO.md)。

## 许可

MIT
