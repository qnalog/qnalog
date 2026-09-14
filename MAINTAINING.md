# 维护说明

本文件说明 QnALog 的维护主线、许可边界、项目身份与发版流程。**改动本仓库前先读第 1、2 节。**

> English summary: QnALog is MIT-licensed software derived from LexVoice's last MIT-licensed release (2.1.2). LexVoice 2.2.0+ is proprietary; its terms do not reach this repository. Never copy code, text, or assets out of a 2.2.0+ build — implement equivalent functionality independently. Keep the plugin id `qnalog` and keep every update source pointing at this repository.

---

## 1. 维护主线

QnALog 是面向 Obsidian 的开源对话智能插件：录音、转写，并把对话整理成结构化 Markdown 知识。三条主线按优先级排列：

### 1.1 第一条：把原有功能维护好（稳定与安全第一）

**保证稳定性与安全性是第一要务，其次是在此基础上线性地提升易用性。**

- 修 bug、修回归、修数据损坏风险、修崩溃与卡死。
- 安全相关：密钥处理、诊断输出脱敏、外部请求边界、权限与路径校验。
- 易用性：在**不改变既有行为语义**的前提下改进提示、默认值、文案与交互路径。措辞是"线性"——小幅、连续、可回退，不是大改。
- 判据：某项改动能降低用户数据丢失/误配置/静默失败的概率，或让既有功能在原场景下确实更顺，就值得做。

### 1.1.1 结构债务：当前阶段先偿还

结构拆解归入第一条，理由是它与稳定性直接相关：单文件过大时，每次改动都要在一个上万行的文件里定位调用点，
改动引入回归的概率随文件规模上升。先拆到可维护，再改具体功能，改动的落点才可控。

拆解限定为纯搬迁：方法体逐行不变、搬迁后调用点等价、不改变任何行为语义。这满足 1.1 对改动的约束
（不改变既有行为语义），因此可以在没有新功能需求时单独推进。

当前规模（2026-09-14 实测，`src` 共 44,993 行）：

| 单体 | 行数 | 形态 |
|---|---|---|
| `src/main.ts` 的 `class LexVoicePlugin` | 10,357 → 513（272 个成员 → 17 个） | 现在只剩装配、持久化、构建信息与更新检查转发 |
| `src/ui/outline-view.ts` 的 `class OutlineView` | 6,468（211 个方法） | 侧边栏视图的界面与业务在同一个类里（P2） |

上一轮（2026-09-13）已把 `src/main.ts` 从 24,679 行降到 10,357 行，抽出 19 个模块；
`src/ui/modals.ts`（2,627 行）是 11 个互不依赖的 Modal 类与 1 个悬浮气泡的集合，不是单体，拆只改变观感。

已抽出的模块原先不构成边界：`RecorderService`、`TaskQueue`、`OutlineView` 以 `declare plugin: LexVoicePlugin`
持有整个插件对象（`src/audio/recorder-service.ts:19`、`src/queue/task-queue.ts:20`、`src/ui/outline-view.ts:100`），
全仓 `plugin.<成员>` 调用 966 处、涉及 114 个不同成员。P1 因此把「搬文件」与「收窄依赖面」一起做。

#### 抽取约定（P1 已按此完成，P2 沿用）

- **一个域一个服务类**：文件 `src/<域>/<域>-service.ts`，类名与文件名对应（`XService`）。类里只放该域的方法与该域自己的状态，
  状态在构造函数里初始化；需要随插件卸载清理的（定时器、监听器、防抖器）由服务提供 `dispose()` 或 `start()`，由插件在 `onload`/`onunload` 调用。
- **窄接口**：服务自带 `export interface <类名去 Service>Host`，只列该域真正用到的宿主能力，运行时传插件实例。
  跨域能力不回到插件上再转发，而是挂拥有它的服务（如 `host.noteWriter.insertBeforeSegmentsStart`、`host.recording.startRecording`）。
- **主体保留装配与生命周期**：插件类只留 `onload`/`onunload`、`loadAll`/`saveAll`/`saveSettings`、构建信息与更新检查转发；
  域字段按域命名（`this.diagnostics`、`this.recording`…），调用点写 `plugin.<域>.<成员>`。
- **纯搬迁**：方法体逐行不变，只把对外依赖改成 `this.host.X`；把服务自身当插件对象传给辅助函数时传 `this.host`（辅助函数读的是 `plugin.settings`）；
  `(this.saveAll || this.saveSettings).call(this)` 这类接收者绑定要跟着改成 `.call(this.host)`。
- **每个域一次提交**，提交前跑 §4.4 的流程，并逐字符比对搬迁前后的方法体。

#### 已完成的 P1（2026-09-14）

`src/main.ts` 从 10,357 行 / 272 个成员降到 627 行 / 17 个成员（P1 完成时的实测值；此后随
§7 的场景裁剪与死代码清理降到 513 行），抽出 22 个域服务与 3 个共享辅助
（下表为拆分当时的清单；招聘 RecruitService 已随 §7 的场景裁剪移除）：

```
诊断 DiagnosticsService · 交付 DeliveryService · 笔记正文 NoteWriter
任务状态 TaskActivityService · 队列失败恢复 QueueRetryService · 版本块 VersionStore · 人员库 PeopleDirectoryService
转写服务配置 TranscribeProfileService · 词汇表与行业提示词 VocabularyService · 迁移与清理 MigrationService
实时大纲 RealtimeOutlineService · 会中工作台 MeetingWorkbenchService · 回听时间轴 AudioTimeLinkService
笔记索引 NoteIndexService · 资料库视图 LibraryViewService · 视图外壳 ViewShellService · 录音 RecordingService
会话收尾 SessionFinalizeService · 导入 ImportService · 外部收件箱 ExternalInboxService · 重新整理 RepolishService
库内收件箱 InboxWatcherService · 知识提取记录 KnowledgeExtractionService
共享辅助：src/shared/util-vault.ts（文件夹创建、路径避让）· 录音器 RecorderService · 任务队列 TaskQueue（上一轮已抽）
```

顺序（P1 已完成，P2 起按此推进；逐项独立提交，每项按 §4.4 的流程验证）：

| 优先级 | 工作 | 完成判据 |
|---|---|---|
| P1 | 拆 `LexVoicePlugin`：定窄接口，按域搬成员与状态 | ✅ 已完成：`main.ts` 只剩装配、生命周期与宿主面（513 行） |
| P2 | 拆 `OutlineView`（211 个方法 / 6,468 行）：界面与业务分层 | 视图类只处理渲染与交互，数据来源改为 P1 定下的服务接口 |
| P3 | 内部标识符改名（`LexVoice*` → `QnALog*`，88 个标识符） | 数据层字面量与 `lexvoice-*` 类名、视图类型不动（见 §3） |
| P4 | `src/ui/modals.ts` 按域拆包 | 可选，不影响维护 |

P3 的边界（实测）：全仓 `LexVoice` / `lexvoice` 共 2,145 处，其中 1,429 处（66.6%）受 §3 保护不可改——
`lexvoice-*` 类名与视图类型 1,315 处（视图类型写进用户的 `workspace.json`）、`LexVoice/…` 路径与 frontmatter 33 处、
`LEXVOICE_*` 常量 57 处、`lexvoice/` 标签 24 处。其中两类改动会直接破坏用户数据：视图类型改名会让已保存的侧边栏布局失效；
`LEXVOICE_SEDIMENT_BEGIN`、`LEXVOICE_ACTIVE_VERSION_START`、`LEXVOICE_NOTE_INDEX_*` 是写在用户笔记里的注释标记；
密钥混淆盐改名会让已保存的 API Key 无法解密。因此改名只覆盖内部标识符，结果是 `QnALogPlugin` 与
`lexvoice-statusbar` 并存。放在 P1 之后做的原因：改名的落点正是 P1 要搬动的代码，同期做会与搬迁的 diff 大面积冲突。

### 1.2 第二条：按需要灵活添加提升性功能

**不要求与上游对齐，也不禁止与上游相同。**

- 确有需要时可以加新功能，包括上游也有、或与上游思路相近的功能——只要实现是我们自己写的（见 §2 的许可边界）。
- 加功能的门槛是"确实有用"，不是"上游有"也不是"上游没有"。
- 不追求功能面的完整对标；不对称是正常的，也是可以接受的。
- 这类改动同样要满足第一条的稳定性标准：新功能不能把既有链路拖坏。

### 1.3 第三条：参照上游做相应调整

**优先级最低，是参考而非目标。**

- 可以参考上游 LexVoice 的公开信息（README、Release Notes、Issue、插件公开行为）来判断"哪些问题值得修、哪些方向有价值"。
- 可以据此在本仓库自行实现相应调整，包括与上游重叠的功能。
- 不做的是"跟上上游的版本节奏"：上游的需求不等于我们的需求，上游的功能删改不需要我们同步。

### 1.4 硬约束（与优先级无关，不可协商）

优先级可以灵活，下面两条不行：

1. **不得复制上游 2.2.0+ 的表达**（代码、文案、注释、结构、素材）——这是许可层面的边界，见 §2。
2. **代码与产物不得指向上游仓库**，插件 `id` 不得与社区目录条目撞车——否则用户会被换成上游版本，见 §3。

---

## 2. 许可边界

### 2.1 为什么本仓库是 MIT，且不受上游专有许可约束

- 本仓库的代码来自 LexVoice 以 MIT 发布的历史提交（tag `2.1.2` 及更早）。MIT 是无 copyleft 的许可，已经授出的权利不可撤回；上游在后续版本换许可证，不影响本仓库这份授权。
- 这不是我们的解读，而是上游自己的书面确认。LexVoice 2.2.0 起的 `LICENSE` 第 1 节原文：

  > It does not revoke, replace, or restrict rights already granted for material previously released under the MIT License, including LexVoice 2.1.2 and earlier MIT-licensed releases. … Adding this license to a later release or changing a repository's visibility does not withdraw an earlier MIT grant, or rights in copies, forks, and derivative works lawfully made under that grant.

- 上游专有许可的适用范围被其自己限定在第 1 节：只覆盖 "original LexVoice material first distributed by the copyright holder with the **2.2.0 release line or later**"。本仓库不含这类材料（见 2.3 的核验），因此该许可对本仓库没有约束力。
- 专有许可不是 copyleft 许可：它的限制只针对"the Software"（2.2.0+ 材料）与接受该许可的使用者，不会反向约束本仓库。

### 2.2 可以做与不可以做

上游许可第 3 节末段自己划出了这条线：

> These restrictions concern the Software, not independent implementations of ideas, general techniques, public APIs, or functionality as such. They do not claim exclusive rights over material that is not protected by applicable law.

由此得到本仓库的执行规则：

| 允许 | 禁止 |
|---|---|
| 依据公开信息（README、Release Notes、Issue、插件公开行为）**自行实现**与上游新版本等价的功能 | 从 2.2.0+ 的 `main.js` / `styles.css` / 文档中**复制**代码、文案、注释、结构或资源 |
| 修改、拆分、重构本仓库内的源码 | 反编译或逐行转录专有 bundle 的实现后"还原"到本仓库 |
| 修复 bug、改善稳定性、增删功能（含删减既有功能） | 复制上游的界面素材、图标、图形或文档排版 |
| 以本项目名义发布 | 复用上游的品牌标识暗示官方身份（见 2.4） |

功能思路本身不受版权保护；受保护的是表达。所以"上游在 2.2.0+ 加了 X，我们也在本项目做 X"不构成侵权，**只要 X 是我们自己写的**。真正的风险只在抄写表达。

### 2.3 隔离核验

确认本仓库没有掺入 2.2.0+ 材料（按内容比对，而非按文件名）：

```bash
# 1) 本仓库与上游专有 tag 之间是否存在内容相同的文件
for tag in 2.2.0 2.3.2; do
  gh api "repos/Lynn-x/LexVoice/git/trees/$tag?recursive=1" > /tmp/up_$tag.json
done
gh api "repos/qnalog/qnalog/git/trees/HEAD?recursive=1" > /tmp/ours.json
# 期望：除 MIT 许可文本（本仓库 LICENSE ↔ 上游 licenses/LEXVOICE-LEGACY-MIT.txt）外无交集

# 2) 构建产物必须能由本仓库源码逐字节复现
npm ci && npm run build && git status --short main.js   # 期望：无输出
```

2026-09-13 的核验结果：与 `2.2.0` / `2.3.2` 的树相比，唯一内容相同的文件是 MIT 许可正文本身；`styles.css` 与上游 tag `2.1.2` 逐字节相同；`main.js` 可由本仓库源码重建（哈希稳定）。

### 2.4 版权声明与归属

- `LICENSE` 中的原始版权与许可声明必须保留——这是 MIT 的强制要求，也是本仓库合法性的基础。
- 本仓库自己的修改，版权归 Q&A Log Team，与原始声明并列，但不得替换或模糊原始声明。
- 归属分布在四处，改动时必须一起核对：`LICENSE`（MIT 正文，逐字不改）、`NOTICE`（来源与修改版权）、`main.js` banner（`esbuild.config.mjs` 注入）、README 的「来源 / 许可证」章节。
- 新增第三方依赖：在 `THIRD_PARTY_NOTICES.md` 登记许可证与用途，并保留其许可原文。
- 声明随产物分发（MIT 要求"随所有副本或实质部分"）：
  - `npm run install:vault` 会把 `LICENSE` 与 `NOTICE` 一并复制进插件目录；
  - 内置更新检查只读取远端 `manifest.json`，不再下载或写入任何文件（见 §3）。
- `LICENSE` 的 MIT 正文必须逐字不变：**不要往 LICENSE 里追加文字**。GitHub 的许可证识别按整文件匹配，追加内容会让仓库显示为无许可证（`NOASSERTION`），而社区目录会因此报 "does not have a recognized license"。

---

## 3. 项目身份与隔离

目的：**装本项目的用户不会因为误操作被换成上游版本；插件也不会自我更新。**

| 环节 | 现状 | 约束 |
|---|---|---|
| 插件 `id` / 目录 | `qnalog` / `.obsidian/plugins/qnalog/` | 上架后**不可更改**（改 id 会重置下载量并要求所有用户重装），所以 id 必须在首次提交前定死。也不得与社区目录中的 `lexvoice` 相同。 |
| 更新检查 | `src/update-source.ts` 常量指向 `qnalog/qnalog@main` | 不得指向上游。改动后必须同步 `tests/` 中的 URL 期望值。 |
| 自更新 | **已移除** | 开发者政策 "Not allowed" 明列 *"Install or update themselves or their dependencies"*。本插件只检查版本并提示，安装交给 Obsidian 或 BRAT。**不得恢复写入自身文件的能力。** |
| 社区目录 | 上游 `lexvoice` 条目仍在 | 不可控。它只能被用户主动安装，不会替换本插件；README 已说明两者并存时的处理。 |
| 数据层 | 笔记标签 `lexvoice/*`、默认目录 `LexVoice/…`、frontmatter 的 `类型: LexVoice派生版本`、API Key 混淆盐 `LexVoice/local-key-obfuscation/v1` | **保持原样，不得因为改名而改动。** 它们已经是既有知识库里的真实数据；混淆盐一旦改动，用户已保存的 API Key 将无法解密。要改必须单独做一次带迁移的版本。 |
| 内部标识符 | `LEXVOICE_*` 常量、`lexvoice-*` CSS 类名、视图类型 `lexvoice-*` | 保持原样：对用户不可见，重命名只会带来回归风险。 |

发版前的指针检查清单——已固化为脚本，CI 每次 push 都会跑：

```bash
node scripts/check-mainline-isolation.mjs
# 检查 src/、scripts/、manifest.json、esbuild.config.mjs、package.json 与构建产物 main.js：
#   1) 不出现上游仓库标识
#   2) main.js 必须包含本仓库更新源地址
#   3) manifest.json 的 id 必须是 qnalog
```

仓库约定：`main` 是唯一工作分支与默认分支。上游产物不得留在任何分支或 tag 上。

---

## 4. 版本号与发版流程

### 4.1 版本号

- 本项目从 `1.0.0` 起独立编号，**不再沿用上游的版本序列**（源码血缘记录在 NOTICE 与本文档，不靠版本号表达）。
- 语义化版本 `x.y.z`，Obsidian 只接受这一格式。
- 破坏性改动升 minor 或 major，并在发版说明里标注。

### 4.1.1 开发分支的构建标识

开发分支编译出的构建必须能在版本号上看出"这是开发版"，否则本地验证时无法区分手上跑的是哪一份构建。
规则（`scripts/build-identity.mjs`）：

| 构建位置 | 版本标识 | 怎么产生 |
|---|---|---|
| `main` 且无未提交改动 | `1.0.0` | 发版身份，与仓库 `manifest.json` 一致 |
| 其他分支 / 有改动 | `1.0.0-dev.<分支>.<提交>[.dirty]` | 构建时注入，安装时写进知识库的 `manifest.json` |
| 游离头指针 | `1.0.0-dev.detached.<提交>` | 同上，分支位用 `detached` |

- **仓库里的 `manifest.json` 始终是发版身份，不随分支变化**——CI 会校验它与 `package.json`、
  `package-lock.json`、`versions.json` 四处一致，社区目录也只接受这一份。开发标识只出现在两处：
  构建产物内部（`LEXVOICE_BUILD_*` 常量）与**知识库里的那份 manifest 副本**（`npm run install:vault` 写入）。
- "有改动"只算两类：已跟踪文件有改动、或 `src/` 下有未跟踪文件。仓库里其他未跟踪草稿文件
  （`_tmp_*`、`ARCHITECTURE.md` 等）不影响打包，不会把构建标成开发版。
- 开发版标识不会触发"版本错位"告警：`UpdateService.warnIfBuildManifestSkew` 只比较 `x.y.z`。
- 查看方式：`node scripts/build-identity.mjs` 直接打印；插件设置页首页与「更新」页也会显示。

### 4.2 发版步骤

```bash
npm version X.Y.Z --no-git-tag-version   # 同步 package.json / package-lock.json
# 编辑 manifest.json 的 version（如 minAppVersion 有变，一并更新）
node version-bump.mjs                    # 写入 versions.json
npm ci && npm run verify                 # lint + build + test
node scripts/check-mainline-isolation.mjs
git add -A && git commit                 # 含重建后的 main.js
git tag X.Y.Z && git push origin main --tags
gh release create X.Y.Z main.js manifest.json styles.css --title "X.Y.Z" --notes-file <说明>
```

- `scripts/check-version-alignment.mjs` 会校验 `manifest.json` / `package.json` / `package-lock.json`（含根版本）/ `versions.json` 四处一致，不一致直接构建失败。
- **必须发布 GitHub Release**：BRAT 与 Obsidian 社区目录都以 Release 资产为安装源，且要求 tag、release 名与 manifest 版本一致。资产为 `main.js`、`manifest.json`、`styles.css`。
- `main.js` 必须入库且与源码同一次提交：运行时会用注入的 `LEXVOICE_BUILD_VERSION`（内部常量名保持不变） 与磁盘 `manifest.json` 比对，版本错位会在设置页提示。
- 若改动触及设置结构（`SETTINGS_SCHEMA_VERSION`）：必须同步更新 `src/shared/settings-migration-report.ts` 里 `DROPPED_GROUP_ACTIONS` / `KEPT_GROUP_NOTES` 的说明，并用一份真实的旧版 `data.json` 跑一遍迁移报告。
- 发版说明必须写明对用户的影响：设置结构是否变化、是否需要重新指定服务绑定、是否有功能删减。

### 4.3 安装、回滚与迁移报告

- `npm run install:vault -- "<知识库>"`：安装/更新到知识库。覆盖前把目标插件目录**整份**留档到 `<知识库>/.obsidian/qnalog-install-backups/<时间戳>/`；首次安装按优先级沿用已有插件设置（`lexvoice` → `lexvoice-mit`），并在沿用上游目录时把该目录也留档。
- `npm run restore:vault -- "<备份目录>" ["<知识库>"] [--set-enabled]`：从备份还原。动手前再把当前目录另存一份（`<时间戳>-before-restore/`），所以回滚本身可撤销。
- 迁移报告：首次加载发现设置结构变化时输出"被丢弃的分组 / 保留的分组 / 需要处理的事项"（通知 + 诊断日志 + console）。**不要**把这段逻辑退回成静默丢弃。

### 4.3.1 合并前置：维护者本地验证

**任何改变用户可见行为的改动，必须由维护者在本机 Obsidian 里实际跑过之后才允许合并进 `main`。**
自动化检查（`npm run verify`、CI 的校验工作流）只能证明"代码自洽"，不能证明"功能可用"——
它们抓不到面板渲染、真实文件、真实模型服务与真机交互上的问题。

流程：

1. 改动在分支上完成，跑通 §4.4 的全部检查。
2. 装进知识库：`npm run install:vault -- "<知识库>"`（覆盖前会自动整目录留档）。
3. 在 Obsidian 里重载（⌘R）并按改动的类型实际走一遍相关路径。
4. **维护者确认可用后**才开 PR 合并；分支合并后再跑一次 `install:vault` 装发版构建。

不要把「CI 绿灯」当作合并许可。允许直接进 `main` 的只有不改变用户可见行为的改动：
文档、注释、纯内部重命名与搬迁（且已由 §4.4 的检查覆盖）。

### 4.4 CI

`.github/workflows/validate.yml` 是**纯校验**工作流：`npm ci` → `npm run build` → `npm test` → 主线隔离检查 → 产物与源码一致性检查。权限仅 `contents: read`，不含任何发布步骤；发布走 §4.2 的人工流程。

`npm run build` 内部依次跑四个静态检查，任一失败即中断：

| 命令 | 拦什么 |
|---|---|
| `npm run check:versions` | `manifest.json` / `package.json` / `package-lock.json` / `versions.json` 版本不一致 |
| `npm run check:undefined-symbols` | `@ts-nocheck` 文件里因不做类型检查而漏掉的未定义引用（TS2304） |
| `npm run check:domain-boundaries` | 插件成员与域服务之间的引用不一致：`plugin.<已搬走的成员>`、`this.host.<未声明的能力>`、`plugin.<域>.<成员>`、`this.host.<域>.<成员>`（后者以服务类为准，接口里手抄的内联类型不作为依据） |
| `npm run check:plugin-onload` | 域服务漏装或宿主装错；侧边栏「纪要」列表默认带隐藏筛选、或该筛选在筛选条上不可见 |
| `npm run check:merge-pipeline` | 会话收尾到合并整理的目标链路跑不通：在模拟宿主里用桩模型真跑一遍，确认整合正文与原始转写都写进笔记 |
| `npm run typecheck:core` + `tsc -noEmit` | 严格核心集与其余文件的类型错误 |

`check:merge-pipeline` 的来源：域服务把自身 `this` 传给 `mergeAndPolish` 后，流水线读
`plugin.settings.briefingStructureLevel` 抛 `TypeError`，真机上表现为 `llm.merge_failed`、纪要无法整理。
这处缺陷通过了 tsc、ESLint、既有契约测试与静态门禁——参数传错对象不会影响引用名，只有真的执行一次才暴露。
因此把这条链路（收尾 → 合并整理 → 写笔记）做成运行检查：桩模型返回固定正文，断言整合正文与原始转写都在笔记里、
frontmatter 仍有 `time`、运行期没有异常日志。

`check:plugin-onload` 的来源：域服务由插件在 `onload` 里手工装配，漏装一个不会有任何编译期报错。
实际发生过一次：`loadAll` 里的设置迁移依赖 migration 与 diagnostics 两个服务，而它们当时在 `loadAll`
之后才装配，迁移因此被静默跳过（`catch` 里只打一行警告）。这条检查同时确认命令、视图、设置页与状态栏
定时器的注册数量没有整体丢失。域服务的字段清单写在脚本顶部的 `DOMAIN_FIELDS`，新增服务时补一行。
该脚本同时建一个真实的侧边栏视图并断言：纪要列表打开时用的是声明的默认筛选（不带隐藏筛选），
且筛选条上必须出现时间范围与模板两个按钮——列表按这些筛选过滤，筛选条上看不到就等于用户求助无门。

`check:domain-boundaries` 的来源：P1 拆分过程中，其它模块里累计出现 176 处指向已搬走成员的 `plugin.<成员>`、
**43 处把服务自身当作插件对象传给辅助函数**（这些辅助函数读 `plugin.settings` / `plugin.app`，传服务实例会读到
`undefined`：一部分直接抛 `TypeError`（真机日志里的 `llm.merge_failed`：
`Cannot read properties of undefined (reading 'briefingStructureLevel')`），一部分被 `try/catch` 吞成静默失效），
以及 1 处把只有会话收尾服务才有的方法挂到录音服务上；三者在 tsc 与既有检查里都不报错，只在运行时失效。
因此这项检查以「字段指向哪个服务类」为准来校验成员名——接口里手抄的内联类型不算依据，
否则那处把 `confirmSpeakerNamesBeforeFinal` 挂到 `recording` 上、而它实际在 `sessionFinalize` 上的错误会被放过。域字段到服务类的对应关系取自 `main.ts` 的
`this.<字段> = new <类>(this)` 装配语句，新增服务无需维护额外映射。

---

## 5. 同步上游

- 只可从 LexVoice 最后一次 MIT 提交（`d924e439`）及其祖先中取材。这是许可边界（§2），不是优先级偏好。
- LexVoice `2.2.0` 之后的实现不可参考代码，只能参考公开描述；同一处缺陷应按本仓库源码自行修复。
- 若上游将来把某次提交以 MIT 形式单独发布，取材时在提交信息中记录证据（上游 commit sha、当时的 `LICENSE`），便于日后追溯。

---

## 7. 功能边界：已裁剪的场景

> 状态：HR 场景裁剪已合并进 `main`（PR #5，merge `4d77796`）并经维护者本机验证；学习卡片裁剪
> 在本分支 `refactor/drop-learning-cards` 上待验证。若后续发现问题，HR 分支
> `refactor/drop-hr-scenarios`（`a333db5`）仍在远端，可直接在其上修正后重新走流程，或整体 revert `4d77796`。



**QnALog 只做四件事：开箱即用的配置、录音、可靠的转写、知识的沉淀与复用。** 围绕核心链路扩展出来的
垂直场景不与核心目标竞争，占用的却是同一份维护成本（每个场景都要跟着提示词、设置页、视图与测试一起改）。

2026-09-14 裁掉 HR 场景，即以下三个模式及其专属设施：

| 移除内容 | 说明 |
|---|---|
| 模式 `recruit` / `recruit-needs` / `promotion-review` | 招聘评估、招聘需求挖掘、晋升评审 |
| `src/recruit/`、`src/promotion/`、`src/prompts/recruit-hrbp.ts` | JD 库与项目三件套、候选人看板、招聘主页 code block、晋升初审生成 |
| 招聘/晋升的 UI | 侧边栏「对象」卡片与内联编辑、招聘上下文弹窗、设置页招聘分组、5 次点击解锁彩蛋、招聘看板 Bases 视图 |
| 招聘专用的提示词与解析 | 逐行问答协议、14 维画像覆盖扫描、追问卡派生、简历脱敏、JD 章节抽取 |
| 相关设置键 | `recruit*`、`promotionReviewContext`、`polishPromptRecruit`；`SETTINGS_SCHEMA_VERSION` 4 → 5 |

保留的模式：综合纪要、工作纪要、访谈、个人笔记、学习笔记、研讨会、圆桌讨论（兼容历史笔记）、关闭（仅转写）。

2026-09-14 裁掉学习卡片场景，理由是它没有回流闭环：

| 移除内容 | 说明 |
|---|---|
| 沉淀的「学习」分组 | `SEDIMENT_GROUP_CONFIG.card`、`SEDIMENT_GROUP_ORDER` 中的 `card`；侧边栏沉淀页少一组（原为人员 → 待办 → 学习 → 热词，现为人员 → 待办 → 热词） |
| 卡片提取与写入 | 沉淀提示词里的 `learningCards` JSON 契约与两条卡片规则、`formatSedimentLearningCardMarkdown`、`getSedimentCardId`、`normalizeSedimentExtractionModel` 的卡片分支 |
| 视图 | `formatLearningWallMarkdown`、`formatConceptWallMarkdown`；「概念墙」与「学习卡片墙」查的是同一批文件（学习卡片同时打 `lexvoice/learning-card` 与 `lexvoice/concept` 两个标签），因此「概念墙」不是独立功能 |
| 命令 | `open-learning-card-wall`、`open-concept-wall`、`open-object-wall`（对象总览只聚合学习卡片+概念+待办，前两者移除后与待办墙等价，已合并为 `open-todo-wall`） |
| 设置键 | `learningCardsFolder`（位于 `vocabulary` 分组内，**不是**顶层分组）；`SETTINGS_SCHEMA_VERSION` 5 → 6 |

判定依据（三条互相独立）：

1. **无回流闭环。** 人员经 `buildPeopleContextForLlm` 进入纪要提示词、经 `buildPeopleHotwordsForAsr` 进入 ASR；
   热词经 `loadVocabularyGroups` 进入 ASR 与 LLM；待办除卡片外还写入当日日记。学习卡片写完即止——
   全仓 `listLearningCards` / `readLearningCard` / `loadLearningCards` 命中 0，没有任何读回路径。
2. **唯一复用路径依赖未声明的第三方插件。** 卡片墙写成 ```` ```dataviewjs ```` 代码块，未安装 Dataview 时
   渲染为代码块。README 的 Requirements 从未列出该依赖。
3. **提示文案与实现不符。** 概念墙空态写「会中用 `#概念` 标记…会出现在这里」，但 `#概念` 是会中 AI
   **解释术语**的触发符（`src/notes/meeting-workbench.ts`），不生成任何卡片；全仓没有把该标记变成卡片的代码。

**§3 保护的数据层字面量（不得改动取值，也不得改作他用）**：`lexvoice/learning-card`、`lexvoice/concept`
两个标签写在用户已有的卡片文件里；`LexVoice/学习卡片`、`LexVoice/资料库/学习卡片` 是既有目录。
用户已生成的学习卡片文件**不删除、不改写**，只是不再有入口。

**兼容规则（改这一节前先读）**：

- **不删除、不改写用户已有文件。** 迁移只重写 `data.json`，不扫描知识库、不动 `.base`、不改笔记内容。
  用户已有的招聘/晋升笔记会留在原处，只是不再有对应入口；`data.json` 里残留的 `recruiting` /
  `promotionReview` 分组不再被读取，首次加载会通过迁移报告告知（§4.2）。
- **数据层字面量继续按 §3 保护**：`lexvoice/*` 标签、`LexVoice/…` 目录、`类型: LexVoice派生版本`、
  密钥混淆盐、`LEXVOICE_*` 常量、`lexvoice-*` 类名与视图类型一律不动。
- **读旧笔记必须安全降级。** 旧笔记的 frontmatter 里可能仍是 `mode: recruit`，未知 mode 一律按
  「识别不出模式」处理，不得抛错、不得让面板或流水线崩掉（`isKnownPolishMode`、`detectRecentNoteMode`
  等处的兜底即为此）。
- **要重新加回某个场景**：按第二条处理——自己实现，并把它当作一等公民补上提示词、设置登记、测试与本文档。

## 6. 待办（按 §1 的优先级排列）

**结构（§1.1.1）**

- [x] P1 拆 `LexVoicePlugin`：已完成（2026-09-14）。`src/main.ts` 10,357 → 513 行，域逻辑与状态在 22 个域服务里。
- [ ] P2 拆 `OutlineView`（`src/ui/outline-view.ts`，211 个方法 / 6,468 行）：界面与业务分层，数据来源改走 P1 的域服务接口。
      现状：该文件 799 处 `LexVoice` 命名、大量 `this.plugin.<域>.<成员>` 调用；拆法沿用 §1.1.1 的抽取约定，
      先分渲染（DOM 组装、卡片与列表）与数据（会话、大纲、候选）两层，再按面板拆子模块。
- [ ] P3 内部标识符改名（88 个 `LexVoice*` → `QnALog*`），数据层字面量、`lexvoice-*` 类名与视图类型不动。
- [ ] P4 `src/ui/modals.ts`（2,627 行 / 11 个 Modal 类 + 悬浮气泡 `BubbleWidget`）按域拆包。可选。
- [ ] 更新检查的 5 个转发（`getUpdateRawBase(s)`、`checkForUpdates(OnStartup)`、`warnIfBuildManifestSkew`）仍留在插件类上，各 2–3 行；
      可并入一个更新域服务，属收尾性质。
- [x] 文档债务：`ARCHITECTURE.md` 的 `main.ts:NNNN` 行号引用已随 P1 失效，已按域服务重新标注（2026-09-14）。
      该文件按 §9 仍不进仓库，待整体重构完成后再并入。

**第一条：稳定性与安全性**

- [ ] 设置页不得静默改写用户配置：`src/ui/settings-tab.ts` 的 `renderSpeaker` 在服务不可用时直接改写 `importTranscribeProvider`，应改为保留用户选择并给出提示。
- [ ] 自定义服务的密钥必填判定：未知 provider id 一律按 `requiresKey: false` 处理，导致密钥栏显示"可选"，但导入时运行时会因缺 key 报错；应改为按 endpoint 推断。
- [ ] 依赖锁定：`package.json` 中 `"obsidian": "latest"` 与其余 `^` 范围应改为精确版本。注：`esbuild` 与 vite 8 的 peer 范围冲突已修（devDep `^0.28.2`）。
- [ ] 类型检查盲区：47 个文件带 `@ts-nocheck`（P1 拆分出的域服务默认沿用；`npm run check:undefined-symbols` 按 tsconfig 自动识别，不写死清单），不参与类型检查；`tsconfig.strict-core.json` 只覆盖 14 个文件。需分期推进。P1 把 `main.ts` 的成员搬到独立模块时，搬迁出的文件默认同样带 `@ts-nocheck`，不改变现状。

**第二条：提升性功能（按需，不排期）**

- [ ] **设置界面精简（开箱即用方向）**：现状设置页偏复杂，把"必须先配的"和"少数人才调的"混在一起。方向是——默认路径只需填 API Key 即可工作（服务、模型、目录用内置默认值 + 一个推荐配置入口），其余自定义项收进"高级"分区。分期推进。注意：设置项读写受 `settings-io.ts` 白名单约束（新增键必须同时登记 normalize 与 serialize），搬动 UI 分组不影响存储结构。
- [ ] **数据层命名的独立化（需要迁移，谨慎）**：笔记标签 `lexvoice/*`、默认目录 `LexVoice/…` 目前沿用上游命名。新用户看到与产品名不一致的目录/标签会困惑，但改动会影响既有知识库。若要做，必须：带迁移脚本、可回滚、并在发版说明中显著提示。**混淆盐（API Key）永远不要改。** 与 §1.1.1 的 P3 分开：P3 只改内部标识符，本项才动用户数据。
- [ ] 为自定义说话人分离服务（如 `siliconflow-diarize`）补预设条目（名称/提示/步骤文案）。纯展示性——能力已具备（`speaker-diarization` 协议），不做也能用。
- [ ] 设置页把未知服务显示为"其他转写服务"。

**不做的事**

- 不为了对齐上游版本号或功能清单而改代码。上游的商业化能力不在本项目目标内。
- 这条同样不绝对：如果某个能力对稳定使用确有价值，按第二条处理——自己实现即可，见 §2。

---

已完成（记录，不再列在待办里）：自更新已移除（仅检查版本并提示，安装交给 Obsidian / BRAT）；
回滚路径已脚本化（`npm run restore:vault`，安装改为整目录留档）；迁移结果自检已实现（首次加载输出对照表）；
`src/main.ts` 首轮分解已完成（24,679 行 → 10,357 行，抽出 19 个模块，2026-09-13）；
P1 拆 `LexVoicePlugin` 已完成（10,357 行 → 513 行，抽出 22 个域服务，2026-09-14）。

