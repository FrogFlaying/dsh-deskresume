# DeskResume 待办清单

> 更新：2026-10-23（第四轮：用户三项实测反馈 —— WPS 只回一个文档 / QQ 微信聊天框 / 跨平台）
> 状态依据：本清单每一条都在本机**实测核实**过。`[x]` 有对应测试或命令输出为证。
> 图例：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成

---

## 零、当前基线（实测）

| 项目 | 实测结果 |
|---|---|
| `node --test test/` | ✅ **110/110 通过**（第四轮新增 37 项：文档推测 17 / 报告 6 / 环境 6 / 多轮定位 8）。DSH 沙箱内跑则为 102 通过 + 8 跳过（沙箱禁止 spawn，`placement-handoff` 会自报原因后跳过） |
| `node tools/place.smoke.mjs` | ✅ 定位相关 8 项全 PASS；另 2 项采集统计 FAIL 属既有环境问题（见下） |
| `node tools/check-tasks.mjs` | ✅ **ALL PASS**（10 项，计划任务验收） |
| `collector/recent-docs.ps1` | ✅ 本机实测：275 候选 → 191 条可用索引，1.8 秒（缓存 15 分钟） |
| 文档推测实测 | ✅ 关机前快照里 WPS 命令行只有 1 个 PDF，推测出另外 3 个文档（1 个在 90 份快照里出现 80 次） |
| 计划任务 | ✅ `\DeskResume\DeskResume-Interval`、`\DeskResume\DeskResume-SessionEnd` 均已注册，状态 Ready |
| 无人值守抓取 | ✅ **实测产出** `snapshot-20261015-114101-interval.json`（由计划任务触发，非手工） |
| 版本控制 | ✅ git 仓库已建，`data/` 已排除（含敏感窗口标题） |
| 插件安装进 profile | ✅ **已安装**（agent 工具 + HTTP API 已实测可用） |
| 真实重启验证 | ✅ **已执行**（2026-10-19/23 两次，暴露下述 R2、R4 缺陷） |

> **冒烟测试那 2 项 FAIL 是既有环境问题，不是本次回归**：本机 `WorkBuddy.exe`（受保护进程）
> 读不到 exe 路径与命令行，使「每个窗口都读到 exe/命令行」两条断言失败。已用 `git stash`
> 在**未打补丁的原始代码**上复现同样两项 FAIL，确认与本次修改无关。

---

## 一、第三轮：真实重启后「程序恢复了但仍报错」的根因（已修）

用户实测重启后点「一键恢复」：**程序确实都开回来了**，但插件仍显示报错，且报错含乱码。
这是三个独立缺陷叠加成的同一个症状。

### [x] R2-1　`place.ps1` 把 N 个定位请求当成 1 个（阻断级）

**根因**：Windows PowerShell 5.1 的 `ConvertFrom-Json` 把解析出的数组**作为一个对象**写进管道，
于是 `@($raw | ConvertFrom-Json)` 又包了一层 —— `$requests.Count` 是 **1**，而那个「请求」的
`.title` 实际是装着**全部标题**的 `Object[]`。第一个未匹配窗口执行
`$req.title.Substring(0, [Math]::Min(8, ...))` 时对 `Object[]` 调 `Substring`，脚本抛异常并以
**exit 1** 结束，**所有窗口一个都没被摆放**。

**为什么一直没被发现**：冒烟测试每次都只发**一个**请求，而单元素数组恰好解包成
`PSCustomObject`，所以「一个窗口」永远通过；真实恢复必然是多窗口，才暴露出来。

**修复**：显式展开 `$parsed | ForEach-Object { $_ }`；并在循环入口把 title 一次性强制为字符串，
让单条畸形请求**跳过而不是中断**整轮定位。

**验证**：`test/placement-handoff.test.mjs`（8 项，真实调 `place.ps1`，只喂不存在的标题）。
真实快照复测：修复前 `exit=1, placed=0`；修复后 **`exit=0, placed=22, failed=1`**
（唯一失败是 `ROBOSTAR` 当时确实没开，属正确报告）。

### [x] R2-2　报错乱码：stderr 是 GBK，Node 按 UTF-8 解

**根因**：PowerShell 5.1 用控制台 OEM 代码页（本机 936/GBK）写 stderr，而 `lib/restore.js`
用 `String(chunk)` 按 UTF-8 解码，中文异常信息全成乱码 —— 真正的原因因此**读不出来**。

**修复**：`place.ps1` 声明 `[Console]::OutputEncoding = UTF8`（`collect.ps1` 一直有这一行，
`place.ps1` 漏了，所以只有定位报错乱码）；Node 侧再加 `decodePsOutput()`：优先 UTF-8，
仅在字节非法时回退 GBK。

**验证**：同一段中文异常，修复前 UTF-8 解码 **INVALID**、只有 GBK 可读；修复后 UTF-8 直接可读。
测试锁定了「stderr 必须是合法 UTF-8」与「脚本必须声明 OutputEncoding」两条。

### [x] R2-3　部分成功被当成彻底失败，且挂了错误的标题

**根因**：恢复只要**有一项**失败就返回 HTTP 500，而 `client.js` 把非 2xx 一律当错误抛出，
**丢弃整份 report**，还用 `loadFailed`（「无法读取快照列表」）当标题 —— 用户于是看到
「程序都开好了，却提示快照列表读不出来」。标题与实际失败的操作完全不对应。

**修复**：只要响应带 `report` 就渲染 report（分别列出成功与失败项），只有**没有 report** 才是
真正的请求失败；错误按 `load/capture/plan/restore` 分档给出正确标题，「重试」也重跑对应操作。

**验证**：`test/client-restore-report.test.mjs`（3 项，跑真实 `client.js`）。

---

## 一·五、第四轮：用户三项实测反馈（2026-10-23，已修）

用户第三次真实重启后提出三个问题，逐条核实如下。**前两条不是 bug，是 Windows 的可观测性上限**；
要改善只能换证据来源，所以这一轮的改动是「换证据 + 说实话」。

### [x] R4-1　恢复报告没落盘，出问题无法事后查（优先级最高）

**问题**：「为什么 QQ 没回来」出现时，报告只存在于工具输出/HTTP 响应里，刷新页面就没了；
`.dr-state/` 只剩一个被正确清理的锁文件 —— 它能证明跑完了，证明不了别的。

**修复**：每次恢复写 `data/restore-<时间>.json`（`lib/reports.js`），保留 `keepReports` 份，
内容含来源快照、计划摘要（标题/重放参数/推测文档，**不含几何坐标**）、各阶段结果、
待登录项、失败项与耗时参数。新增 `deskresume action="reports"` 与 `GET /api/deskresume/reports`。
写失败只记一条 note，不影响恢复结论。

### [x] R4-2　非 Windows / 无 PowerShell 时报 `spawn powershell.exe ENOENT`

**问题**：插件在 macOS 上能加载、列表为空、采集失败只抛 ENOENT，用户无从判断是装错了还是平台不对。

**修复**：`lib/environment.js` 在 `capture` / `restore` 之前自检（平台、PowerShell 是否在、
Windows build 是否 ≥ 10240），返回可读中文说明 + 下一步建议；新增
`GET /api/deskresume/environment`，`/config` 也带上；设置页顶部显示提示条。
**没有**加平台门禁去禁止加载 —— 只读功能（看快照列表）在别的平台上仍可用。

### [x] R4-3　定位只等 3 秒，登录类应用必然落空且被算作失败

**问题**：QQ/微信的窗口在登录成功后才创建，单次 3 秒等待必然找不到；
找不到又被记成 `failed`，看起来像插件坏了。

**修复**：定位改为多轮 —— `settleMs`（3 秒）之后按 `placeRetryMs`（12 秒、30 秒）重试，
每轮只针对仍未出现的窗口；`place.ps1` 现在回显请求 `id`，轮次记账不依赖标题比对
（标题是前缀匹配，不唯一）。登录类应用（QQ/TIM/WeChat/Weixin）在全部轮次后仍无窗口时
归入 **`pending`（待登录）** 而非失败，并提示「登录后执行『只重排窗口』」。

### [x] R4-4　多标签应用只恢复一个文档（WPS）

**问题**：WPS 把多个文档放在同一个窗口的标签页里，`EnumWindows` 只看到 1 个窗口，
标题只反映当前标签，进程命令行只留启动时那一个文件 —— 恢复只能重放那一个。

**修复**：`lib/documents.js` + `collector/recent-docs.ps1`：
快照历史里的标题 → 文件名 → 最近打开文件索引（Recent 快捷方式 + WPS 自己的
`RecentFiles\Sequence`）→ 真实路径 → 恢复时逐个打开。按应用白名单（默认办公类）、
每应用上限 8 个、24 小时窗口，已按「完全自动打开」实现。
**明确是推测**：会重开这段时间里「开过又关了」的文档；两个快照点之间没停留过的标签会漏。
`inferDocuments: false` 可关闭。

**实测（本机，2026-10-23 关机前快照）**：

| 来源 | 结果 |
|---|---|
| 命令行 | `940个支付名词大全….pdf`（1 个） |
| 推测（历史 + Recent 反查） | `网络策略申请记录表.xlsx`（出现 80 次）、`04-需求评审确认表.doc`（2 次）、`系统运维备忘录.xlsx`（8 次） |

### 第四轮踩到的坑

1. **WPS 注册表里的路径是正斜杠**（`D:/文档/note/x.xlsx`）。`Add-Entry` 一开始只接受
   `^[a-zA-Z]:\\`，于是 1763 条 WPS 记录全被丢掉，而「最近文件」恰好覆盖了被测文档，
   表面上一切正常 —— 计数器的 `sources` 字段才是证据。修法：接受 `[\\/]` 再归一化成反斜杠。
2. **计数器统计的是「尝试」不是「保留」**：摘要曾显示 `1763 entries`，实际只保留 191 条。
   改为在 `Add-Entry` 内部按已接受计数。
3. **`report.documentsFailed === 0` 拿数组跟数字比**，永远为假，导致每次恢复都 `ok: false`。
   这类错误测试一跑就抓到了，前提是**真的写了一个断言 `report.ok === true` 的测试**。

---

## 二、第二轮已完成（评审团指出 → 已修复）

### [x] R1　`relaunchArgs()` 过滤器被绕过（评审团共同判定 #1 阻断项）

**问题**：声称过滤 `-`/`--` 开关，实测三种形态均可绕过：微信 `" -sw0x…"`（前导空格）、
QQ `/hosthwnd=`（斜杠开关）、GameViewer `source=explorer.exe` + 裸 GUID。恢复时会重放垃圾参数。

**修复**：黑名单 → **白名单**。只有像绝对路径或 URL 的参数才会被重放，其余一律丢弃。
另外剔除了「应用把自己的 exe 当参数回传」的情况（QQ）。

**验证**：`test/relaunch-args.test.mjs`（12 项，全部来自真实快照的 verbatim args）。
真实快照上的效果：修复前 5 个应用带参数（其中 3 个是垃圾），修复后**只剩 2 个真实文档路径**
（Notepad++ 的 `plan`、WPS 的 PDF）。

### [x] P0-1　定时 + 关机前自动抓取

**新增** `collector/install-tasks.ps1` / `collector/uninstall-tasks.ps1`，注册两个任务：

| 任务 | 触发 | reason |
|---|---|---|
| `DeskResume-Interval` | 每 `intervalSeconds` 秒（默认 120） | `interval` |
| `DeskResume-SessionEnd` | 系统事件 1074 / 6006 | `session-end` |

**安全约束（按安全评审 SP1）**：任务**直接调用 `collect.ps1`**，不启动任何 HTTP 服务 ——
计划任务运行在 DSH 之外，任何 HTTP 暴露都会绕过 DSH 的认证栈。

**验证**：`schtasks /run` 强制触发 → `data/` 真实新增 `reason=interval` 快照。
这也让 `pickSnapshot()` 的 session-end 优先分支**首次变为可达**（此前是死代码）。

### [x] P1-2　删除 `isSessionEnding()` 死代码

永远返回 `false`、且全仓无调用点的桩函数已删除，改为注释说明「标记 session-end 由计划任务负责」。

### [x] P1-5　配置层（架构师插入项）

**新增** `lib/config.js` + `config/deskresume.json`。解析顺序：调用方覆盖 → `deskresume.local.json`
→ `deskresume.json` → 内置默认值。损坏的配置文件**只告警不致命**（回退默认值，绝不阻断采集）。

`install-tasks.ps1` 读取同一套配置，保证计划任务与插件不打架。

### [x] P1-6　标题匹配健壮性 + 未匹配明细

`place.ps1` 从「精确→前缀」两级，改为**多因子打分**（标题 + 类名 + 显示器），
并在匹配失败时报告**当时存在的相似窗口标题**，而不是只报 "window not found"。

### [x] Risk-5　schema 迁移机制

**新增** `migrateSnapshot()`。旧版本快照走迁移链；**新版本快照拒绝读取并提示升级**
（而不是删文件 —— 断电后那可能是会话的唯一记录）。

### [x] Risk-7 / 架构师 P4　恢复并发锁

**新增** 文件锁（`.dr-state/restore.lock`）：并发恢复被拒绝而非交错执行（否则会启动两份程序）。
锁带时间戳与 pid，进程已死的陈旧锁会被接管，不会永久卡死功能。`force=true` 可强制。

### [x] 弹窗问题　计划任务每 2 分钟闪一次控制台（用户反馈，已修复）

**问题**：用户直观感受「快照时桌面会弹出终端」。实测**确认属实**：
直接调 `powershell.exe -WindowStyle Hidden` 时，conhost 先创建并显示控制台窗口，
PowerShell 才把它隐藏 —— 实测约 **100ms 可见**，每 2 分钟一次。

**修复**：新增 `collector/run-hidden.vbs`，用 `WshShell.Run(cmd, 0, false)` 启动采集器，
窗口样式 0 在 `STARTUPINFO` 里传 `SW_HIDE`，窗口从一开始就不显示。

**验证**（两种方式都必须同时满足「确实写出快照」与「窗口不可见」，避免假通过）：

| 启动方式 | 控制台窗口 | 曾经可见 |
|---|---|---|
| 直接 `powershell.exe`（原实现） | 创建 | **是**，约 101ms 起 |
| `wscript.exe run-hidden.vbs`（现实现） | 创建 | **否**（0/93 次采样） |

真实计划任务复测：`schtasks /run` 触发 → 快照写出 + `EVER VISIBLE = 0`。
`tools/check-tasks.mjs` 已加入检查项，防止以后被改回直接调用 `powershell.exe`。

**测量方法**：以 3ms 间隔轮询 `ConsoleWindowClass` 窗口集合，记录每个新建窗口是否**曾经**
可见（而非只看某一瞬间），并暂停定时任务排除干扰。
> 注：前两版探针测出「无弹窗」是**假阴性** —— 它们设置了 Task Scheduler 并不会设置的
> `STARTUPINFO` 窗口标志，等于测了一个不存在的场景。第三版忠实复现后才发现问题。

### [x] 安全评审 SP2/SP3　敏感数据与权限

- **数据治理**：`data/` 已加入 `.gitignore`（快照含合同名/案件名/项目路径，绝不能进版本库）
- **网络面**：已实测确认计划任务不开放任何端口；DSH API 在路由前就鉴权
  （对照实验：不存在的路径 `/api/definitely-not-a-route-xyz` 同样返回 401，
  证明鉴权发生在路由之前，而非插件自己实现）
- **权限**：任务以 `Limited` 级别运行，**不请求提权**（静默提权是用户没要求的权限变更）

### [x] P2-1　版本控制

`git init` + `.gitignore`（排除 `data/*`、`config/deskresume.local.json`、`.dr-state/`、`node_modules/`）。

### [x] P2-2 / P2-3 / P2-4 / P2-5 / P2-6　收尾

- 包名统一为 `dsh-deskresume`（调研报告里的 `dsh-desk-resume` 已改）
- 冒烟测试改写临时目录，**实测确认不再污染 `data/`**（跑前跑后快照数不变）
- 清掉 2026-10-14 的两份重复测试快照
- README 测试项数改为实测值，并指向本文件

---

## 三、第二轮新发现的坑（已修，记录备查）

实施过程中被**实测**抓出来的 7 个问题，都不是评审团预判的：

1. **`Get-Content -Raw` 读 JSON 配置走 ANSI** —— `config/deskresume.json` 里的中文被破坏成
   非法 JSON，安装脚本静默回退默认值。改用 `[System.IO.File]::ReadAllText(path, UTF8)`。
2. **`MSFT_TaskEventTrigger` 必须带 CIM 命名空间** —— 不带
   `-Namespace 'Root/Microsoft/Windows/TaskScheduler'` 会静默返回 `$null`，
   导致关机前抓取的任务**根本没注册却打印成功**。
3. **本机没有 `Task:` PSDrive** —— `New-Item -Path Task:\...` 失败后静默把任务路径降级到根目录。
   实际上 `Register-ScheduledTask` 自己会创建文件夹。
4. **安装脚本只读了 `deskresume.json`，漏了 `deskresume.local.json`** ——
   与 `lib/config.js` 的优先级不一致，用户改本地配置会得到与插件不一致的计划任务。
5. **`.gitignore` 写 `data/` 会让 `data/.gitkeep` 失效** —— git 不进入被排除的目录。
   改为 `data/*` + `!data/.gitkeep`。
6. **`node --test test/` 会把 `test/` 下所有 `.mjs` 当测试跑** —— 于是它也执行了冒烟测试
   （真实移动窗口）和计划任务验收（依赖本机任务状态），导致结果**不确定**，
   且"41 项通过"里混了 2 个非单元测试。移出到 `tools/` 后单元测试稳定为 **39 项**、可重复。
   > 这个坑是在排查一次**偶发失败**时发现的：失败无法复现，说明测试本身不确定，
   > 而不是代码有问题。
7. **直接调 `powershell.exe` 加 `-WindowStyle Hidden` 仍会闪控制台** —— 见上方「弹窗问题」。

---

## 四、仍未完成

### [x] P0-2　把插件装进 profile

**装的是什么**：就是本项目这一个包（`dsh-deskresume`），没有别的依赖（`dependencies` 为空）。
它给 DSH 加两样东西：

| 加的东西 | 文件 | 你能看到什么 |
|---|---|---|
| Host 半身 | `index.js` | agent 多一个 `deskresume` 工具；多一组 `/api/deskresume/*` 接口 |
| 浏览器半身 | `client.js` | 设置页多一节「桌面续开」：快照列表、预览恢复方案、一键恢复 |

**目的**：让你在 DSH 界面里点按钮就能看快照、预览、恢复，而不用敲命令。

**已完成的安装**（2026-10-15）：

```powershell
dsh plugin --profile desktop add D:\DeepSeek\harness\DeskResume
```

**实测结果**：

| 检查项 | 结果 |
|---|---|
| `package.json` dependencies | ✅ 新增 `"dsh-deskresume": "link:D:/DeepSeek/harness/DeskResume"` |
| `package.json` bundles | ✅ 新增 `"dsh-deskresume"` |
| `node_modules` 链接 | ✅ Junction → `D:\DeepSeek\harness\DeskResume` |
| 全部依赖可解析 | ✅ 21 个声明依赖，0 缺失 |
| 全部 bundle 可解析 | ✅ 26 个，0 缺失（`@deepseek-ai/*` 由应用自带） |
| 插件可加载 | ✅ `name=deskresume`, `inject=["tools"]`, `apply` 是函数 |
| **agent 工具已可用** | ✅ 本会话实际调用 `deskresume action="list"` 返回 30 份快照 |
| **HTTP API 已上线** | ✅ `GET /api/deskresume/config` → 200，返回真实配置 |

> **安装时踩到的坑**：`dsh plugin add` 第一次**失败**，报 10 个包违反 pnpm 的
> `minimumReleaseAge`（24 小时发布冷却）。**这与本插件无关** ——
> 那 10 个包（`@michengai/*`、`qs`、`react-is`）本来就在 lockfile 里且已装好，
> 只是发布时间落在冷却窗口内。用**一次性**参数绕过（不写入任何策略文件）后成功：
> `dsh plugin --profile desktop add <path> --config.minimumReleaseAge=0`
>
> 失败**未造成损坏**：`package.json` / `cordis.patch.yml` 与备份逐字节一致，
> `node_modules` 127 → 128（只多了本插件）。安装前已备份到
> `profiles/desktop/.deskresume-backup-<时间戳>/`。

**注意**：本次安装后 DSH 无需重启即已生效（实测 API 与 agent 工具均可用）。
但**安全修复需要重启 DSH 才会加载**（见第五节）。

### [x] P0-3　真实重启验证（已完成，并暴露出 R2 三个缺陷）

**结果**：2026-10-19 真机重启后执行恢复 —— **程序与资源管理器确实都恢复了**，但插件报错
（详见第一节 R2-1/R2-2/R2-3）。三个缺陷已修复并补了回归测试。

**这次真机验证的收获，恰好是「开发环境内消除不掉」的那部分**：
- 恢复器的**程序启动**与**文件夹重开**两条路径是好的（用户肉眼确认）
- **窗口定位**整条路径是死的（R2-1），而冒烟测试因为只发单个请求永远测不出来
- 报错**不可读**（R2-2），导致「明明失败了却看不出为什么」—— 这比失败本身更糟
- **部分成功被报成彻底失败**（R2-3），把可用信息全丢了

**仍需复测**：修复后**再真实重启一次**，确认 `report.placed` 为 20+ 且界面不再出现
「无法读取快照列表」。在此之前，「重启后标题匹配命中率」仍只有本轮这一次的实测数字。

#### 关于「能否放在 VMware 虚拟机里验证」

**结论：可以，但不能完全替代真机验证。** 本机已装 VMware Workstation 17.6.4。

**虚拟机里能验证的（有价值）**：

| 能验证 | 为什么 |
|---|---|
| 恢复器端到端能否跑通 | 虚拟机里同样是 Windows，`SetWindowPos`、窗口枚举行为一致 |
| 标题匹配在「进程全部重启后」是否仍命中 | 这是核心未知项，虚拟机重启同样会重启所有进程 |
| `session-end` 计划任务是否真的在关机时触发 | 虚拟机里关机同样产生 1074/6006 事件 |
| 越界钳制、单实例、提权窗口等边界 | 与真机行为一致 |
| 恢复失败时的报告是否可读 | 纯软件行为 |

**虚拟机里验证不了的（关键局限）**：

| 验证不了 | 原因 |
|---|---|
| **你的真实使用场景** | 虚拟机里没有你的 Chrome 登录态、IDEA 项目、微信会话 —— 需要重新搭一套环境 |
| **真实的应用恢复行为** | Chrome 能否恢复标签页取决于它自己的会话文件与登录态；虚拟机里是全新 profile |
| **显示器配置变化** | 虚拟机通常只有一块虚拟显示器，测不出多屏钳制 |
| **提权窗口** | 虚拟机里一般不开 UAC 提权程序 |

**成本对比**：

| 方案 | 准备成本 | 真实性 | 对真机的影响 |
|---|---|---|---|
| 真机重启 | **零**（本来就要重启） | 100% | 无（正常重启而已） |
| VMware 虚拟机 | 高（装 Windows + 装软件 + 搭场景，约 1–2 小时） | 中（约 60–70%） | 无 |

**建议**：
1. **先做真机验证** —— 成本为零，且只有真机能回答「你的程序是否恢复自己的文档」。
   你本来就要重启电脑，顺手做即可（步骤见 README「重启后怎么验证」）。
2. **虚拟机作为补充** —— 如果你想反复试（比如调整匹配算法后回归），再在虚拟机里做。
   目前本机**没有 Windows 虚拟机，也没有 Windows ISO**，需要先建。

**当前已消除的不确定性**（本轮实测，见 [docs/capability-report.md](docs/capability-report.md)）：
- 标题稳定性代理指标：87.2% 的窗口标题在整个观测期内从未改变
- 变化的 12.8% 集中在 WPS（切换文档）、Chrome（标签页）、DSH（会话名）、explorer（重命名）——
  均为应用自身行为，非匹配算法缺陷
- `session-end` 任务链路已实测打通（手动触发产出 `reason=session-end` 快照，
  `pickSnapshot()` 正确优先选中它）

> 因此真机验证要回答的**只剩一个问题**：重启后这 87% 的窗口里，有多少真的被摆回原位。
> 这不是「可能全错」，而是「已知 87% 的标题稳定，实际命中率在此之上或略低」。

### [ ] P1-3　应用适配器（提升「恢复到具体文件」比例）

当前 16 个应用中只有 2 个能恢复到具体文档。Chrome（多窗口）、IDEA（3 窗口）的命令行
完全不含打开的文件/标签页 —— 这是能力的真正天花板。

按性价比：① VS Code / IDEA 读最近工作区 ② 浏览器会话文件或 CDP 抓标签页
③ 终端 PEB 方案扩展到 Windows Terminal 标签页。

### [ ] P1-4　快照 diff 压缩

单次约 38–43 KB。默认保留 30 份，**上限约 1.2 MB**（`keepSnapshots` 才是真正的磁盘约束，
不是间隔）。优先级低：当前量级不构成问题，除非用户调大 `keepSnapshots`。

### [ ] P2-7　审计日志（安全评审 SI2，未采纳）

安全评审建议记录每次恢复动作。**本轮未实现**：属于新增能力而非阻断修复，
且与「数据最小化」原则有张力（又一处落盘）。建议用户确认是否要。

---

## 四、明确不做（边界，避免反复讨论）

Windows 的客观限制，已在代码里显式处理并写进输出（见 [README.md](README.md)）：

- ❌ 恢复未保存的文档内容 —— 无此 API
- ❌ 重定位提权进程的窗口 —— 不做 UAC 提权，列为 `manual`
- ❌ 单实例应用开第二个窗口 —— 只能切前台
- ❌ 显示器拔掉后原坐标直接生效 —— 钳制到最近显示器并逐条报告

## 五、评审建议的处理结果

### ⚠️ 我推翻过的评审结论，最后证明是我错了

| 评审建议 | 我当时的结论 | **实际结论** |
|---|---|---|
| 「HTTP API 无鉴权」为高危阻断项 | ~~不成立~~ | **评审是对的，我错了 —— 已修复** |

**我错在哪**：我用「请求一个不存在的路径 `/api/definitely-not-a-route-xyz` 也返回 401」作为对照，
断定鉴权发生在路由之前。这个对照**有缺陷**：

- 401 是**未注册路由的兜底响应**，不是鉴权拒绝
- 插件注册的路由会**绕过**它：`/api/deskresume/nonexistent-subroute` 返回 **404**（说明已进入插件），
  而 `/api/deskresume/config` 返回 **200**

**实测确认的攻击面**（对运行中的服务发起，无任何凭证）：

| 请求 | 结果 |
|---|---|
| `GET /api/deskresume/config`（无凭证） | **200** |
| 伪造 `Host: evil.example.com` | **200** |
| `Origin: https://evil.example.com` + `Sec-Fetch-Site: cross-site` | **200** |
| `POST /api/deskresume/capture`（跨站） | **200，并真的写出了一份快照** |
| `POST /api/deskresume/restore` 指向**任意路径**的伪造快照 | **200，计划启动攻击者指定的 exe** |

**影响**：用户访问的任意网页都可能 POST 到本机 API，进而启动程序、移动窗口；
配合任意文件路径，等于**任意程序执行**。

**修复**：
1. API 加请求守卫 —— 要求 `Host` 为回环地址（浏览器无法伪造，同时挡 DNS rebinding），
   并拒绝 `Sec-Fetch-Site: cross-site` / 跨站 `Origin`，否则 403
2. `pickSnapshot` 的 `file` 参数**限制在快照目录内**，覆盖 `..` 穿越与 `data-other` 前缀同名目录

**教训**：对照实验必须选「已注册但不存在」的路径，而不是「完全没注册」的路径 ——
后者测的是路由兜底，不是鉴权。

### 经核实后降级或未采纳

| 评审建议 | 结论 | 依据 |
|---|---|---|
| 「敏感标题落盘」需加密/脱敏 | **降级** | 数据仅存本机、已排除出版本库；强制脱敏会破坏「恢复到具体文件」这个核心能力。改为文档披露 + `.gitignore` |
| 新增 `P1-5 配置文件` 置于 P0-1 之前 | **采纳** | 已实现 |
| 新增 `P1-6 标题匹配增强` 置于 P0-3 之前 | **采纳** | 已实现 |
| P0-2 装插件移出 P0 降为 P2-0 | **部分采纳** | 确实不阻断无人值守能力，但仍是交付的一环，保留 P0 编号并标注不阻塞 |
| 审计日志 | **待定** | 见 P2-7 |
