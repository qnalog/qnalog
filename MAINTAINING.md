# 维护说明

本文件说明 Q&A Log 的维护主线、许可边界、项目身份与发版流程。**改动本仓库前先读第 1、2 节。**

> English summary: Q&A Log is MIT-licensed software derived from LexVoice's last MIT-licensed release (2.1.2). LexVoice 2.2.0+ is proprietary; its terms do not reach this repository. Never copy code, text, or assets out of a 2.2.0+ build — implement equivalent functionality independently. Keep the plugin id `qnalog` and keep every update source pointing at this repository.

---

## 1. 维护主线

Q&A Log 是面向 Obsidian 的开源对话智能插件：录音、转写，并把对话整理成结构化 Markdown 知识。三条主线按优先级排列：

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
| `src/main.ts` 的 `class QnALogPlugin` | 10,357 → 513（272 个成员 → 17 个） | 现在只剩装配、持久化、构建信息与更新检查转发 |
| `src/ui/outline-view.ts` 的 `class OutlineView` | 6,468 → 6,263（211 个方法） | 侧边栏视图的界面与业务在同一个类里（P2：维护者决定不再继续，已退出 `@ts-nocheck`） |

上一轮（2026-09-13）已把 `src/main.ts` 从 24,679 行降到 10,357 行，抽出 19 个模块；
`src/ui/modals.ts`（2,627 行）是 11 个互不依赖的 Modal 类与 1 个悬浮气泡的集合，不是单体，拆只改变观感。

已抽出的模块原先不构成边界：`RecorderService`、`TaskQueue`、`OutlineView` 以 `declare plugin: QnALogPlugin`
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

P2（视图层）在以上约定之外另有三条：

- **视图只留渲染与交互**：`createEl`/`createDiv`/`menu`/事件绑定留在视图；文件读写、LLM 调用、
  数据变换搬进服务。判据是该成员是否依赖视图实例的 DOM。按此口径实测 `OutlineView` 的 210 个方法里
  有 59 个不碰 DOM（合计 2,154 行），其余仍要留在视图。
- **服务不持有视图引用**：需要重建 DOM 时由视图传回调，不要 `this.host.shell.refreshOutlineView()` 之外
  再反向依赖视图类。注意各重绘时机的语义不同，不能用一个回调统一代替——`scheduleUpdate()` 会按渲染签名
  决定是否重建，`render()` 立即重建。实测语义 Canvas 一处就有三种时机（见 `SemanticCanvasRepaint`），
  混用会让进度态不显示或让高频路径重建 DOM。
- **新建域服务要登记两处清单**：`scripts/check-plugin-onload.mjs` 的 `DOMAIN_FIELDS`（漏登记则该服务不被检查，
  注释里已写明新增时要补一行）。`check-domain-boundaries.mjs` 按 `XxxHost` 接口自动识别，无需登记。

#### 已完成的 P1（2026-09-14）

`src/main.ts` 从 10,357 行 / 272 个成员降到 627 行 / 17 个成员（P1 完成时的实测值；此后随
§7 的场景裁剪与死代码清理降到 513 行，2026-09-23 实测 696 行），抽出 22 个域服务与 3 个共享辅助
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
| P1 | 拆 `QnALogPlugin`：定窄接口，按域搬成员与状态 | ✅ 已完成：`main.ts` 只剩装配、生命周期与宿主面（513 行） |
| P2 | 拆 `OutlineView`（211 个方法 / 6,468 行）：界面与业务分层 | 已完成的部分：语义 Canvas 抽成独立域服务，该文件退出 `@ts-nocheck`。**维护者决定不再继续**（理由与重启条件见 §6） |
| P3 | 命名空间重置：内部标识符与 CSS 类名、数据层字面量、视图类型统一为 Q&A Log | ✅ 已完成（见 §1.1.2）：两次改动均已落地 |
| P4 | `src/ui/modals.ts` 按域拆包 | 可选，不影响维护 |

#### 1.1.2 命名空间重置（P3，已完成）

上一轮对 P3 的估算把 860 个 `lexvoice-*` CSS 类名与视图类型一并算作"受 §3 保护不可改"（1,315 处），
因此结论是"只改内部标识符，结果是 `QnALogPlugin` 与 `lexvoice-statusbar` 并存"。实测否定了这个分类：
类名**不落盘**——知识库里 `lexvoice-*` 只出现在注释标记与生成墙的 dataviewjs 内，没有一处是 `cssclasses`；
落在 `workspace.json` 的只有两个视图类型字面量。因此 P3 拆成两次改动，边界按**"这个字符串是否会被写进用户文件"**划：

| 改动 | 内容 | 依据 |
|---|---|---|
| 第一次（`refactor/namespace-internal-identity`，已合并） | 内部标识符 82 个、`lexvoice-*` 类名与 CSS 自定义属性 862 个、`QNALOG_VAULT` 环境变量、注释与文档 | 全部只存在于代码里，不写用户文件；无需迁移 |
| 第二次（`refactor/data-namespace-reset`） | `LexVoice/…` 默认目录、`lexvoice/*` 标签、笔记标记与 frontmatter 键（`lexvoice_speakers`、`类型: LexVoice派生版本`）、视图类型、混淆盐、`lvwall-*` 类名 | 已是既有知识库里的真实数据，需带迁移 |

第二次的做法（只认一个命名空间）：

- **写入与读取都只用 Q&A Log 字面量。** 字面量集中在 `src/shared/namespace.ts`，
  读侧用 `nsRe()` 生成模式，不要在业务代码里硬编码品牌前缀。
- `SETTINGS_SCHEMA_VERSION` 重置为 `1`（1.0.0 发布时的 clean break）。
- 不提供笔记数据迁移命令：既有笔记里的旧命名空间标记不再被识别，也不改写。
  用户按全新项目使用，自行决定旧目录里的文件如何处置。

**设置版本政策（2026-09-15 起，见 §4.5）**：clean break 只对 **pre-1.0** 成立。
1.0.0 之后存在正式用户，版本向前走时**必须迁移、不得丢弃**——API Key、服务配置、
提示词、路径、设备选择都是用户的财产。

**第二次不做的事**：不自动改写知识库里 `LexVoice/` 这个目录名（那是用户自己的文件），
也不在加载时扫描或改写任何笔记。插件只按默认值创建 `QnALog/…`。
`install-to-vault.mjs` 不再从 `lexvoice` / `lexvoice-mit` 继承设置，只处理"已有 Q&A Log → 留档 → 装新 Q&A Log"。
许可来源（`LICENSE`、`NOTICE`、README 的 Origin、产物 banner）不参与改名。

**密钥混淆盐**（`qnk1:` + `QnALog/local-key-obfuscation/v1`）只认本插件自己的 marker：
前缀不匹配的串不解密、原样返回，不会被当成密文处理。换过盐的旧值解不出来，
用户在设置页重新填写即可。

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
| 书面名称 | 界面、提示词、生成的标题、文档、仓库简介 | 面向人阅读处一律写 **`Q&A Log`**（含 `manifest.json` 的 `name`）。程序性与数据层保持 `qnalog` / `QnALog`（见下两行）——三层不得混用。 |
| 内部标识符 | `QNALOG_*` 常量、`qnalog-*` CSS 类名与自定义属性 | 2026-09-14 已统一为 `qnalog`：这些字符串只存在于代码里，不写用户文件。**新代码不得再引入 `lexvoice-*` 类名或 `LEXVOICE_*` 常量。** |
| 数据层 | 标签 `qnalog/*`、默认目录 `QnALog/…`、frontmatter 键 `qnalog_speakers`、类型值 `QnALog派生版本`、视图类型 `qnalog-*-view`、混淆盐 `QnALog/local-key-obfuscation/v1`（marker `qnk1:`） | 2026-09-15 已重置为 QnALog 命名空间，**读写都只认新值**（见 §1.1.2）；字面量集中在 `src/shared/namespace.ts`，**新代码不得再引入 `lexvoice-*` 字面量**。 |

发版前的指针检查清单——已固化为脚本：CI 每次 push 都会跑，本地 `npm run verify` 也包含（2026-09-15 起并入，避免只在改动特定文件时手跑而漏掉）：

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
  构建产物内部（`QNALOG_BUILD_*` 常量）与**知识库里的那份 manifest 副本**（`npm run install:vault` 写入）。
- "有改动"只算两类：已跟踪文件有改动、或 `src/` 下有未跟踪文件。仓库里其他未跟踪草稿文件
  （`_tmp_*`、`ARCHITECTURE.md` 等）不影响打包，不会把构建标成开发版。
- 开发版标识不会触发"版本错位"告警：`UpdateService.warnIfBuildManifestSkew` 只比较 `x.y.z`。
- 查看方式：`node scripts/build-identity.mjs` 直接打印；插件设置页首页与「更新」页也会显示。

### 4.2 发版步骤

推 tag 之后由 `.github/workflows/release.yml` 自动完成构建校验与上传，维护者只做前四步：

```bash
npm version X.Y.Z --no-git-tag-version   # 同步 package.json / package-lock.json
# 编辑 manifest.json 的 version（如 minAppVersion 有变，一并更新）
node version-bump.mjs                    # 写入 versions.json
# 写发版说明：.github/release-notes/X.Y.Z.md（工作流要求该文件存在）
npm ci && npm run verify:push            # lint + build + test + 主线隔离 + 产物一致性
git add -A && git commit                 # 含重建后的 main.js
git push origin main                     # ⚠ 会被分支保护拒绝，改用 PR（见下）
git tag X.Y.Z && git push origin X.Y.Z   # 推 tag 触发发布工作流
```

> **先确认 `main` 到位，再推 tag。** `main` 有 `Main Protect` 规则，**直推会被拒绝**：
> `! [remote rejected] main -> main (push declined due to repository rule violations)`。
> 而 tag 推送**不受该规则约束**，于是「提交 → 推 main → 推 tag」这套顺序会走成
> 「main 没动，tag 却推出去了」——2026-09-15 发 1.0.1 时就是这样：Release 正常发布，
> 但 `main` 的 `manifest.json` 仍停在上一个版本。
>
> 正确做法：版本提交走 PR 合并进 `main`，**合并成功后再**打 tag、推 tag。
> 若已经从 tag 发了版，事后用 PR 把版本提交补回 `main`（提交内容与 tag 逐字节相同，
> 可用 `git diff X.Y.Z HEAD --stat` 为空来核对）。
>
> Release 本身不受影响：发布工作流检出的是 **tag 指向的提交**，不是 `main` 的指针。

发布工作流（`Release`）在 tag 上依次做：

1. 检出 tag 指向的提交（干净检出、`fetch-depth: 0`，provenance 的起点）；
2. **要求 tag 指向的提交已在 `main` 上**（`scripts/check-release-tag-on-main.mjs`）——
   `main` 的 `Main Protect` 拒绝直推，而**推 tag 不受该规则约束**；两者叠加会让 Release
   正常发出去、`main` 却停在旧版本。这条把它变成机械失败（下文「先确认 `main` 到位」）；
3. `npm ci` 锁定安装；
4. **tag 与 `manifest.json` 的版本一致**，否则拒绝发布；
5. `npm run verify:push`（lint / build / test / 主线隔离 / 产物一致性）；
6. **重建后的 `main.js` / `manifest.json` / `styles.css` 与 tag 里提交的逐字节一致**，
   否则拒绝发布——这条拦的正是「提交进来的产物不是这份源码构建的」；
7. 要求 `.github/release-notes/<tag>.md` 存在（不允许用自动生成的提交列表顶替）；
8. 上传 **5 个资产**：`main.js`、`manifest.json`、`styles.css`、`LICENSE`、`NOTICE`；
9. 回读一次，确认用户下载到的与 tag 里的逐字节一致。

工作流失败时**不要**改用本地 `gh release create` 绕过（见下文）：那等于放弃 provenance。

- 发版说明的模板见 `.github/release-notes/1.0.0.md`。**必须写明对用户的影响**：设置结构是否变化、是否需要重新指定服务与密钥、是否有功能删减。
- **LICENSE 与 NOTICE 随 Release 一起发**：README 的手工安装方式就是让用户下载这些文件，版权与许可声明应当随分发副本一起走，而不是只靠 `main.js` 顶部 banner 里的 URL。
- `scripts/check-version-alignment.mjs` 会校验 `manifest.json` / `package.json` / `package-lock.json`（含根版本）/ `versions.json` 四处一致，不一致直接构建失败。
- **必须发布 GitHub Release**：BRAT 与 Obsidian 社区目录都以 Release 资产为安装源，且要求 tag、release 名与 manifest 版本一致。
- `main.js` 必须入库且与源码同一次提交：运行时会用注入的 `QNALOG_BUILD_VERSION` 与磁盘 `manifest.json` 比对，版本错位会在设置页提示。
- 工作流失败时**不要**改用本地 `gh release create` 绕过：那等于放弃 provenance，release 里的文件就不再保证来自 tag。先在 tag 上修源码、重打 tag。
- 若已发布后需要修发版说明文字（不改产物），可直接 `gh release edit X.Y.Z --notes-file …`，无需重新发版。
- 若改动触及设置结构（`SETTINGS_SCHEMA_VERSION`）：改动那个常量即可，**不要**为旧格式补逐键迁移。版本不一致时插件整份丢弃磁盘设置、按默认值重建（`src/shared/settings-schema.ts`），并弹通知。改动后要用一份真实的旧版 `data.json` 验一遍这条路径。
- 发版说明必须写明对用户的影响：设置结构是否变化、是否需要重新指定服务绑定、是否有功能删减。

### 4.3 安装与回滚

- `npm run install:vault -- "<知识库>"`：安装/更新到知识库。覆盖前把目标插件目录**整份**留档到 `<知识库>/.obsidian/qnalog-install-backups/<时间戳>/`；2026-09-15 起不再从 `lexvoice` / `lexvoice-mit` 目录继承设置（本插件按独立产品维护）。检测到上游插件目录时只提示存在，不读取、不移动、不删除其内容。
- `npm run restore:vault -- "<备份目录>" ["<知识库>"] [--set-enabled]`：从备份还原。动手前再把当前目录另存一份（`<时间戳>-before-restore/`），所以回滚本身可撤销。
- 设置结构不一致时：`loadAll` 丢弃磁盘上的设置与持久化队列，按默认值重建，弹通知并在诊断日志里记一条（`settings.schema_reset`）。**不要**把这段逻辑退回成静默沿用旧值。

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

本仓库有两个工作流，权限按用途分开：

| 工作流 | 触发 | 权限 | 做什么 |
|---|---|---|---|
| `validate.yml` | 每次 push 与 PR | `contents: read` | 纯校验：`npm ci` → `npm run verify:push`（唯一入口，见下） |
| `release.yml` | 推 `[0-9]*` 形式的 tag | `contents: write` | 从 tag 干净检出、重建产物、逐字节比对后上传 Release 资产（§4.2） |

`release.yml` 是**唯一**带写权限的工作流，且只由维护者推 tag 触发——它不接受 `workflow_dispatch`，
也不在 push 分支时运行，避免任何人借它创建 Release。

**CI 的真实定义 = `package.json` 里的 `verify:push`。** `validate.yml` 只有两步：装依赖、
跑 `verify:push`——不在 workflow 里另维护一份检查清单。否则同一批门禁要同时记在
package.json、validate.yml、release.yml 三处，新增检查漏改一处就会出现「两边都绿、
但有一项谁都没跑」。以后新增检查只要进入 `build` / `verify`，PR CI 与 Release 自动获得，
不需要记得改 workflow。
CI 的两个不可替代之处是**跨平台第二意见**（ubuntu / Node 22，本地是 macOS / Node 22）
与**校验已推送状态**（干净检出后从 HEAD 构建，比的是仓库里真实提交的东西，而不是工作区；
PR 上检出的是合并引用，比的是 A+B 的合并结果）。触发器仍是 `push: [main]` +
`pull_request`：裸推分支不跑，CI 不是内层循环工具。

**required status check（Main Protect）**：ruleset 要求 check context `validate`
（workflow `name: Validate` + job id `validate`，由 `tests/validate-workflow-contract.test.ts`
钉住——改名后 GitHub 会继续等待旧 context，PR 永远无法满足规则）通过才允许合并，并开启
「须基于最新 main」：产物复现（本文）、架构基线（§13）、设置结构（§4.5）都是**合并后状态**
的属性，A 在旧 main 上的绿灯不能证明 A+B 也绿。配置顺序必须是：先把 `validate.yml` 的
`verify:push` 入口合并进 main、确认 main 上跑绿一次，再在 ruleset 里选择该 check——
先配规则会让 GitHub 等待一个从未出现过的 context，把仓库锁住。

本地与 CI 的能力对照：`validate.yml` 逐字执行 `npm run verify:push`，因此 **CI 覆盖 =
本地 `verify` 全链 + `check:bundle-consistency`**，两者的定义只存在于 package.json 一处。
本地内层循环仍用 `verify`；推送前跑 `verify:push`，CI 跑的就是同一个命令。

`verify:push` 在推送前跑，比 `verify` 多一项 `check:bundle-consistency`：把 HEAD 里参与构建的文件导出到临时目录、在那里打包、与 HEAD 里的 `main.js` 逐字节比对。它补的是「构建后看 `git status --porcelain main.js`」这条本地检查的结构性盲区——那条只发现「重新构建了但忘了 `git add`」，如果压根没重新构建，工作区的产物与 HEAD 一致，会给出假通过。该脚本要求源码已提交（否则直接报错退出，不静默忽略），所以不放进提交前跑的 `verify`。

`npm run build` 内部依次跑下列检查，任一失败即中断；表中标注 `verify` 的三项只在 `npm run verify` 里跑
（`verify` = `lint` + `build` + `test` + 主线隔离 + 旧前缀门禁 + 设置映射表门禁）：

| 命令 | 在哪跑 | 拦什么 |
|---|---|---|
| `npm run check:versions` | `build` | `manifest.json` / `package.json` / `package-lock.json` / `versions.json` 版本不一致 |
| `npm run check:undefined-symbols` | `build` | `@ts-nocheck` 文件里因不做类型检查而漏掉的未定义引用（TS2304） |
| `npm run check:domain-boundaries` | `build` | 插件成员与域服务之间的引用不一致：`plugin.<已搬走的成员>`、`this.host.<未声明的能力>`、`plugin.<域>.<成员>`、`this.host.<域>.<成员>`（后者以服务类为准，接口里手抄的内联类型不作为依据） |
| `npm run check:architecture` | `build` | 新增的 `src/main.ts` 依赖、legacy 文件 `plugin.*` 能力面回涨、服务依赖图的新边或新环（基线制，见 §13） |
| `npm run check:plugin-onload` | `build` | 域服务漏装或宿主装错；侧边栏「纪要」列表默认带隐藏筛选、或该筛选在筛选条上不可见 |
| `npm run check:merge-pipeline` | `build` | 会话收尾到合并整理的目标链路跑不通：在模拟宿主里用桩模型真跑一遍，确认整合正文与原始转写都写进笔记 |
| `npm run typecheck:core` + `tsc -noEmit` | `build` | 严格核心集与其余文件的类型错误 |
| `npm run check:legacy-prefixes` | `verify` | 白名单之外的旧品牌前缀（`lex-` / `lv-` / `lvk-` / `lexvoice-`）重新进入源码或样式表 |
| `npm run check:settings-map` | `verify` | §9.1 的设置映射表与代码脱节：设置键增删、或落盘路径改名后没同步 |
| `npm run lint` | `verify` | eslint（`eslint-plugin-obsidianmd` recommended；console 只允许 warn/error/debug） |

`check:legacy-prefixes` 的来源：品牌改名靠人工枚举字面量，实测漏了三轮——
第一次只处理 `lexvoice-*` 而漏掉更短的 `lex-*`（录音文件名一直叫 `lex-<时间戳>.webm`，
1.0.0 用户已有这类文件）；第二次漏了 `--lv-sediment-*`（123 处）与 `--lvk-*`（9 处）；
同一批还漏了 `genId()` 的 `lv-`、`lvtask-`、沉淀 id 与实时转写块标记。
漏掉的那些一旦进入用户数据就变成永久兼容负担。这条检查把「有没有漏」变成机械可判定的问题。
需要保留的旧写法（读取 1.0.0 遗留数据）集中在 `src/shared/namespace.ts`，
并在脚本的 `ALLOWED` 里逐条登记理由——新增条目时要先自问：这是**读取兼容**，还是漏改？

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

### 4.5 设置结构版本政策

分界线是 **1.0.0 的发布时刻**。这条线两侧的规则相反，改代码前先确认你在哪一侧。

| 磁盘 `schemaVersion` | 判定 | 处理 |
|---|---|---|
| = 当前 | `current` | 直接读回 |
| < 当前且 ≥ 1 | `migrate` | **跑迁移链，保留用户数据** |
| > 当前 | `future` | **不写盘**（`saveAll` 直接返回）。用户回退了插件，磁盘上是新版写的设置；按旧结构写回会洗掉新版字段 |
| 0 / 非数字 / 无 | `foreign` | 别的项目、pre-1.0 遗留或损坏：丢弃重建，**但先把原文件复制到 `<插件目录>/settings-backups/`** |

判定与迁移链在 `src/shared/settings-schema.ts`；`loadAll` 是唯一调用点，`saveAll` 有一道 `future` 闸门。

**1.0.0 之后新增设置字段的步骤**（三步，缺一不可）：

1. `SETTINGS_SCHEMA_VERSION` +1；
2. 在 `SETTINGS_MIGRATIONS` 里登记 `[旧版本]: (settings) => 迁移后的 settings`，
   只负责那一次结构变更，**不要重建整个对象**（那会把用户填的值换成默认值）；
3. 在 `tests/settings-schema-policy.test.ts` 加一条「旧版 data.json → 用户配置仍在」的用例。

缺链时 `migrateSettingsForward` 返回 `null` 而不是半成品，调用方据此不写盘——
宁可让用户停在可读状态，也不要用一半的迁移结果覆盖他的配置。

**不要**把 pre-1.0 或 LexVoice 的数据接回这套迁移链：那些版本走 `foreign`。
两件事没有关系。

**回归防线**：`scripts/check-plugin-onload.mjs` 用一份 1.0.0 用户的 `data.json`
驱动真实的 `loadAll`，断言密钥/模型/队列都在、`future` 时零写盘、`foreign` 时回默认值。
经反向验证：把 `loadAll` 改回「版本不一致就整份丢弃」、或去掉 `future` 闸门，该检查都会失败。

## 5. 同步上游

- 只可从 LexVoice 最后一次 MIT 提交（`d924e439`）及其祖先中取材。这是许可边界（§2），不是优先级偏好。
- LexVoice `2.2.0` 之后的实现不可参考代码，只能参考公开描述；同一处缺陷应按本仓库源码自行修复。
- 若上游将来把某次提交以 MIT 形式单独发布，取材时在提交信息中记录证据（上游 commit sha、当时的 `LICENSE`），便于日后追溯。

---

## 6. 待办（按 §1 的优先级排列）

> **阶段分界（2026-09-15，1.0.0 发布）**：「偿还遗留技术债」阶段基本结束，重心转为
> **保护正式用户的升级体验**。判据是——问题会不会影响已安装用户的数据或升级路径？
> 会 → 优先；不会 → 按下面的顺序排。§4.5 的设置版本政策是这条转向的第一个产物。

**当前优先级（正式用户时代）**

1. **已完成的 P0**：设置改为向前迁移，不再整份丢弃（§4.5）；
   设置页不再在渲染时静默改写用户的导入服务选择。
2. **对外材料与代码一致**：默认目录表、PRIVACY 的更新检查描述、workflow 注释（已完成）。
3. **发布链路自动化**：`release.yml` 提供 tag → 干净检出 → 重建 → 比对 → 上传的 provenance（§4.2）。
4. **首次配置体验**：见下方「第二条：提升性功能」的设置界面精简。
5. **收尾性工程债**：3 个 `@ts-nocheck`、`modals.ts` 拆包、更新检查转发——均低风险、可延后。

**结构（§1.1.1）**

- [x] P1 拆 `QnALogPlugin`：已完成（2026-09-14）。`src/main.ts` 10,357 → 513 行，域逻辑与状态在 22 个域服务里。
- [x] P2 拆 `OutlineView`：**维护者决定不再继续**（2026-09-14）。
      - 已完成的部分：语义 Canvas 抽成 `src/canvas/semantic-canvas-service.ts`（`outline-view.ts` 6,468 → 6,263 行）；
        该文件同日退出 `@ts-nocheck`，现受类型检查。
      - 停止的理由（实测数据）：拆分只能带走 27% 的类型错误，而补 38 个字段声明消掉 71%；
        文件退出 `@ts-nocheck` 后，「方法改名但调用点保留」这类漏改会被 `tsc` 当场抓住
        （此前 `tsc`、`check:undefined-symbols`、`check:domain-boundaries`、`check:plugin-onload` 四道门禁全绿、
        411 项测试全过）。因此拆分对可维护性的边际收益已经很小。
      - 剩下的主要代价：88 个沉淀相关方法里 36 个仍读视图私有字段（`sedimentGroup`、`sedimentScanToken`、
        `sedimentToastTimer`…）。搬这些要把视图状态机一起搬，属重构而非搬迁，且会牵动界面行为——
        与 §1.1「不改变既有行为语义」相冲突，需要独立的设计与逐项视觉验证。
      - **重启条件**：若将来出现必须改 `outline-view.ts` 结构性问题的需求（例如某个面板要独立成视图、
        或某类 bug 反复出现且定位困难），再按 §1.1.1 的抽取约定分簇推进，不要为了「文件变小」而拆。
- [ ] P3 命名空间重置（见 §1.1.2）：
      - [x] 第一次：内部标识符（82 个）+ `lexvoice-*` 类名与自定义属性（862 个）+ `QNALOG_VAULT`（2026-09-14）。
      - [x] 第二次（2026-09-15）：数据层命名空间（默认目录、标签、笔记标记与 frontmatter 键、视图类型、混淆盐）
            + 读写只认新值 + 删除全部迁移逻辑（迁移命令、`MigrationService`、迁移报告）+
            `SETTINGS_SCHEMA_VERSION` 重置为 1 + 删除 `install-to-vault.mjs` 的旧插件设置继承。
- [ ] P4 `src/ui/modals.ts`（2,627 行 / 11 个 Modal 类 + 悬浮气泡 `BubbleWidget`）按域拆包。可选。
- [ ] 更新检查的 5 个转发（`getUpdateRawBase(s)`、`checkForUpdates(OnStartup)`、`warnIfBuildManifestSkew`）仍留在插件类上，各 2–3 行；
      可并入一个更新域服务，属收尾性质。
- [x] 文档债务：`ARCHITECTURE.md` 的 `main.ts:NNNN` 行号引用已随 P1 失效，已按域服务重新标注（2026-09-14）。
      该文件是本地工作稿（未入库，也不在 `.gitignore` 中），待整体重构完成后再并入。

**第一条：稳定性与安全性**

- [x] 设置页不得静默改写用户配置：已完成。`renderSpeaker` 改为只在内存里借用第一个可用服务渲染界面，设置保持用户原值，并在页面上说明原因（`settings-tab.ts:1436`）。
- [x] 自定义服务的密钥必填判定：已完成。未知 provider 按 endpoint 推断（`asr/transcribe-profile-service.ts:253`）。
- [ ] 依赖锁定：`package.json` 中 `"obsidian": "latest"` 与其余 `^` 范围应改为精确版本。注：`esbuild` 与 vite 8 的 peer 范围冲突已修（devDep `^0.28.2`）。
- [ ] 类型检查盲区：3 个文件带 `@ts-nocheck`（`asr/clients.ts`、`ui/settings-tab.ts`、`ui/modals.ts`），不参与类型检查；`tsconfig.strict-core.json` 只覆盖 14 个文件。2026-09-14 已把其余 44 个清完（47 → 3），做法与逐文件成本见 §8。**新抽出的文件不要再默认加 `@ts-nocheck`**：先按 §8 试算，能通过检查就不加。
  - 已完成：2026-09-14 分两批让 26 个文件退出 `@ts-nocheck`（47 → 21）：先 14 个零错误的，再 12 个低错误的（1–7 处）。做法、逐文件成本与修法见 §8。**新抽出的文件不要再默认加 `@ts-nocheck`**：先按 §8 试算确认能否通过检查，能通过就不加。

**第二条：提升性功能（按需，不排期）**

- [ ] **设置界面精简（开箱即用方向）**：现状设置页偏复杂，把"必须先配的"和"少数人才调的"混在一起。方向是——默认路径只需填 API Key 即可工作（服务、模型、目录用内置默认值 + 一个推荐配置入口），其余自定义项收进"高级"分区。分期推进。注意：设置项读写受 `settings-io.ts` 白名单约束（新增键必须同时登记 normalize 与 serialize），**搬动 UI 分组不影响存储结构**——简单界面与高级界面读写同一批字段，不引入第二套同步逻辑。
  - [x] **任务 0：盘点**。已产出 §9 的逐键映射表（87 个键：默认值、落盘位置、读回别名、作用、现入口、拟归属）与 11 条规则冲突登记，并加 `check:settings-map` 门禁防表过期。
  - [ ] 目标状态：新用户不必理解"模型 / 协议 / 转写流程"就能录出第一条语音笔记；已有用户升级后配置不变。判据与约束见 §9.5。
  - [x] **任务 1：统一配置与检测逻辑**。预设写入范围收敛为 10 个键（清单在 `PRESET_WRITTEN_FIELDS`）；四份检测合并为 `runPresetDetection` 一处；检测对象改为候选配置且不落盘；状态改为四态。见 §10。
  - [ ] 后续批次（每次一批，不夹带录音流水线重构）：① 按 §9.2 重排页面，首次配置收敛为一条路径（含说话人页拆分、方案应用内联副本）；② 最后处理工作面板。推荐用哪家服务需另行核实（§9.4）。
- [x] **数据层命名的独立化**：已完成（2026-09-15，见 §1.1.2）。Q&A Log 按全新项目处理，不支持从历史项目迁移数据，代码里不再保留迁移逻辑；混淆盐已换新，已存 API Key 需重填。
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

## 7. 功能边界：已裁剪的场景

> 状态：HR 场景裁剪已合并进 `main`（PR #5，merge `4d77796`）并经维护者本机验证；学习卡片裁剪
> 在本分支 `refactor/drop-learning-cards` 上待验证。若后续发现问题，HR 分支
> `refactor/drop-hr-scenarios`（`a333db5`）仍在远端，可直接在其上修正后重新走流程，或整体 revert `4d77796`。



**Q&A Log 只做四件事：开箱即用的配置、录音、可靠的转写、知识的沉淀与复用。** 围绕核心链路扩展出来的
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

同一提交顺带修掉设置页「资料库」卡片区的两处排版问题（`styles.css` 的
.`qnalog-object-overview-grid` / `.qnalog-object-overview-card`）：

| 问题 | 原因 | 处理 |
|---|---|---|
| 卡片头部不齐（截图里「待办」比另两张低 18px） | 核心 `button` 规则设 `align-items` / `justify-content: center`，卡片只覆盖了 `display` 与 `height`。卡内内容不足 132px 时被垂直居中：说明文字两行的卡片顶部偏移 17.6px，一行的偏移 26.9px。4 张卡时同理（「学习卡片」与「待办」都是 26.9px），删掉一张后才在视觉上暴露 | 卡片补 `align-items: flex-start` 与 `justify-content: flex-start`，让标题、计数、说明文字都靠左上；说明文字此前也被水平居中，不再与标题左对齐 |
| 右侧空出一列 | 列数写死 `repeat(4, …)`，卡片数 4 → 3 后第 4 列留空 | 改为 `repeat(auto-fit, minmax(170px, 1fr))`，列数随容器宽度与卡片数变化；同时删除两条 `@container` 里写死列数的规则（`600px` → 2 列、`320px` → 1 列），它们在 3 张卡片时会把卡折成两行并空出一格 |

**兼容规则（改这一节前先读）**：

- **不删除、不改写用户已有文件。** 迁移只重写 `data.json`，不扫描知识库、不动 `.base`、不改笔记内容。
  用户已有的招聘/晋升笔记会留在原处，只是不再有对应入口；`data.json` 里残留的 `recruiting` /
  `promotionReview` 分组不再被读取。这类残留分组随版本不一致的设置一起被丢弃，不再单独报告。
- **统一使用 Q&A Log 命名空间**（标签、标记、frontmatter 键、视图类型）：命名空间已于 2026-09-15 重置，
  读写都只认新值（见 §1.1.2）。插件不扫描、不改写用户的既有笔记。
- **读旧笔记必须安全降级。** 旧笔记的 frontmatter 里可能仍是 `mode: recruit`，未知 mode 一律按
  「识别不出模式」处理，不得抛错、不得让面板或流水线崩掉（`isKnownPolishMode`、`detectRecentNoteMode`
  等处的兜底即为此）。
- **要重新加回某个场景**：按第二条处理——自己实现，并把它当作一等公民补上提示词、设置登记、测试与本文档。

## 8. 类型检查：逐步退出 `@ts-nocheck`

`@ts-nocheck` 会让 `tsc` 跳过整个文件。要判断某个文件能否退出，先量成本、再只改成本为 0 的：
用 TypeScript 编译器 API 建 `Program`，在 `host.getSourceFile` 里对目标文件去掉指令行后重新解析，
再读 `program.getSemanticDiagnostics()`（过滤掉 TS2304，它是 `check:undefined-symbols` 的活）
与 `getSyntacticDiagnostics()` 的错误数。这一步只读不写，可以一次算出全部文件的成本。

2026-09-14 分五批完成 **47 → 3**。按去指令后的错误数（`tsconfig.json` 口径）分档，
括号内是当时实测的错误数；已完成的文件不再列出：

| 状态 | 文件 |
|---|---|
| 已完成（44 个） | 错误数 0 的 14 个、1–7 的 12 个、8–20 的 9 个，
以及 `external-inbox-service`(23)、`task-queue`(28)、`recording-service`(23)、
`realtime-outline-service`(29)、`task-activity-service`(29)、`recorder-service`(237)、
`session-finalize-service`(65)、`main.ts`(31)、`outline-view`(398)、`semantic-canvas-service`(1) |
| **剩余（3 个，暂停）** | `asr/clients`（约 250）、`ui/settings-tab`（约 471）、`ui/modals`（约 508） |

**剩余 3 个暂停的理由（2026-09-14 维护者决定）**：这三个都在 250 处以上，且 `settings-tab` 与
`modals` 是 UI 密集文件，错误多来自 Obsidian DOM API 与动态设置对象——处理方式与其它文件不同，
需要逐个方法收窄，工作量大且琐碎；`modals.ts` 本身是 11 个互不依赖的 Modal 类的集合，不是单体。
`@ts-nocheck` 在这三个文件上的实际风险有限（它们的改动频率低，且 `check:undefined-symbols`
仍覆盖 2304 类悬空引用）。**重启条件**：若某个文件要改结构性问题，或出现只有类型检查才拦得住的
回归，再单独做那一个。

错误集中在四类，修法固定：

1. **默认参数 `options = {}` 让属性变成不存在（TS2339，占比最大）。** 补一个选项接口，属性声明为可选，
   默认值不动。例：`RefreshNoteIndexOptions`、`UpsertGeneratedMarkdownOptions`、`QnALogObjectWallOptions`、
   `QueueTaskFilterOptions`、`MeetingWorkbenchRunOptions`。
2. **联合类型成员没列全（TS2322）。** 例：`checkpoint.topicMapSource` 的类型缺 `"part-summaries"`
   （`merge-pipeline.ts` 会写这个值但类型里没有）。
3. **属性只存在于联合类型的一个变体（TS2339）。** 例：`QueueTask.audioPath` 只在 transcribe 变体上，
   用 `"audioPath" in task` 收窄；非 transcribe 任务仍按空串处理。
4. **可选参数被声明成必填（TS2554）。** 函数体本来就按可选处理，把签名改成带默认值即可：
   `mergeAndPolish` 的 `repolishOptions`、`postProcessBriefingOutput` 的 `topNotice`、
   `getEffectivePolishMode` 的 `fallback`、`callLlm` 的 `options`。

第 3、4 类里可能藏真实问题，改之前先确认调用点。例如 `merge-pipeline.ts` 原先写
`Object.assign(part, { status: ... })` 后读 `part.status`，TypeScript 依据赋值把后续比较收窄成恒假（TS2367）；
改成先存局部变量、赋值与判断共用，语义不变。

**跨模块的状态字段要显式声明。** TypeScript 不推断「仅在构造函数中赋值」的属性——实测
`noImplicitAny`、`strictNullChecks`、`strict` 三种口径都不推断。因此 `@ts-nocheck` 类写成
`constructor() { this.state = "idle" }` 时，其它模块读 `svc.state` 一律报「属性不存在」。
`RecorderService` 有 31 个这样的字段，对消费方只可见 1 个。跨模块被读取的字段必须写成
`declare state: ...` 之类的类字段声明。**拆 `OutlineView`（P2）前要先补齐它要依赖的服务的字段声明**，
否则视图侧会持续报「属性不存在」。

两道门禁在退出指令后都不会自动覆盖新文件，因此改完必须手动反向验证一次：
在刚退出的文件里写入一个未定义符号，确认 `tsc` 报 TS2304（不是在 `check:undefined-symbols` 里报）。

**不要用严格档衡量这批文件。** `strictNullChecks` + `noImplicitAny`（`tsconfig.strict-core.json` 的口径）
下，第一批那 14 个文件及其依赖闭包实测有 740 处错误，与「能否退出 `@ts-nocheck`」是两个独立目标。
退出 `@ts-nocheck` 只要求文件在 `tsconfig.json` 现有选项下零错误，不要求 stricter 选项。

---

## 9. 设置映射表

维护多个设置界面之前，先把**每一份设置的当前状态**盘清：入口、默认值、落盘键、作用与归属。本节是 2026-09-15 盘点的产物，覆盖 `PluginSettings` 的全部 **87** 个顶层键，`SETTINGS_SCHEMA_VERSION = 1`。

**三列由脚本从源码解析生成，不是手工抄写**，因此不会与代码脱节：默认值取自 `src/shared/defaults.ts`；落盘位置与读回别名取自 `src/shared/settings-io.ts` 的 `serializePluginSettings` 与 `normalizePluginSettings`；现入口取自 `src/ui/settings-tab.ts` 及其余 UI 写点（侧边栏、命令面板、弹窗、拖动）。`scripts/check-settings-map.mjs` 会核对本表的键集合与落盘路径，键增删或改路径而未更新本节时构建失败。

列含义：

- **落盘位置**：`serializePluginSettings` 写出的分组路径。该函数是**重建式白名单**——没有在这里登记的键，会在下一次保存时被静默丢弃（`src/shared/settings-io.ts` 头部有警告，该类问题已出现三次）。

- **读回别名**：`normalizePluginSettings` 额外接受的旧分组路径。每个键都还有一层平铺兜底 `raw.<键>`，不逐一列出；`—` 表示只认落盘位置与平铺两个来源。

- **现入口**：当前能改到它的界面。`无` = 没有界面入口；`（只读）` = 界面只展示不修改。

- **拟归属**：本轮建议的新位置，分层见 §9.2。

### 9.1 逐键映射

| 设置键 | 默认值 | 落盘位置 | 读回别名 | 作用 | 现入口 | 拟归属 |
|---|---|---|---|---|---|---|
| `uiLanguage` | `""` | `ui.language` | — | 界面语言；空串表示跟随 Obsidian | 关于 | 基本设置 |
| `audioFolder` | `${NS_ROOT}/录音` | `storage.recordingLibraryPath` | — | 录音文件落盘目录 | 录音 | 基本设置 |
| `mdFolder` | `${NS_ROOT}/转写纪要` | `storage.briefingNotePath` | — | 纪要 Markdown 落盘目录 | 录音 | 基本设置 |
| `meetingMaterialsFolder` | `${NS_ROOT}/会议资料` | `storage.meetingMaterialPath` | — | 会中补充材料（图片/PPT/PDF）的复制目标 | 录音 | 高级 · 输出 |
| `htmlReportFolder` | `${NS_ROOT}/HTML报告` | `storage.htmlReportPath` | — | HTML 报告保存目录 | AI 整理 | 高级 · 输出 |
| `reportBrandName` | `""` | `presentation.reportBrandName` | — | 「研讨」报告页脚公司名；留空则取纪要里的公司标签 | AI 整理 | 高级 · 输出 |
| `noteFileNameFormatNew` | `"YYYY-MM-DD HHmm"` | `noteNaming.sessionPattern` | — | 纪要文件名日期格式 | 录音 | 高级 · 输出 |
| `transcribeEndpoint` | `"https://api.siliconflow.cn/v1/audio/transcriptions"` | `speech.compatEndpoint` | — | 兼容兜底：provider 未填地址时的回退（asr/transcribe.ts:147） | 无 | 内部（保留存储，不进设置界面） |
| `transcribeApiKey` | `""` | `speech.compatApiKey` | — | 兼容兜底：provider 未填密钥时的回退（asr/transcribe.ts:148） | 无 | 内部（保留存储，不进设置界面） |
| `transcribeModel` | `"FunAudioLLM/SenseVoiceSmall"` | `speech.compatModel` | — | 兼容兜底：provider 未填模型时的回退（asr/transcribe.ts:149） | 无 | 内部（保留存储，不进设置界面） |
| `transcribeLanguage` | `"auto"` | `speech.compatLanguage` | — | 兼容兜底：provider 未填语言时的回退（asr/transcribe.ts:150） | 无 | 内部（保留存储，不进设置界面） |
| `activeTranscribeProvider` | `"siliconflow"` | `speech.activeProviderId` | — | 实时录音使用的转写服务 id | API | 基本设置 |
| `importTranscribeProvider` | `"dashscope-filetrans"` | `speech.importProviderId` | — | 导入音频（整文件）使用的转写服务 id | API | 高级 · 服务 |
| `importSpeakerDiarization` | `false` | `speech.importSpeakerDiarization` | — | 导入音频是否区分说话人（可选项，默认不启用） | API | 高级 · 服务 |
| `importSpeakerCount` | `0` | `speech.importSpeakerCount` | — | 导入音频预期的说话人数（0=自动） | API | 高级 · 服务 |
| `transcribeProviders` | `{…}` | `speech.providers` | — | 各转写服务的地址/密钥/模型/语言注册表 | API（经 provider 子对象） | 基本设置 |
| `llmEndpoint` | `"https://api.siliconflow.cn/v1/chat/completions"` | `composer.endpoint` | — | AI 整理服务地址 | API | 高级 · 服务 |
| `llmApiKey` | `""` | `composer.apiKey` | — | AI 整理服务访问密钥 | API | 基本设置 |
| `llmModel` | `""` | `composer.model` | — | AI 整理模型标识 | API | 高级 · 服务 |
| `llmServicePreset` | `"siliconflow"` | `composer.servicePreset` | — | 服务预设 id，用于填地址与请求头适配 | API | 高级 · 服务 |
| `llmProfiles` | `[]` | `composer.profiles` | — | 已保存的 API 方案（转写+AI 整理为一套） | API + 侧边栏 | 基本设置 |
| `activeLlmProfile` | `""` | `composer.activeProfile` | — | 当前启用的 API 方案 id | API + 侧边栏 | 基本设置 |
| `polishMode` | `"synthesis"` | `composer.defaultMode` | — | 默认纪要模板（整理方式） | AI 整理 + 侧边栏 + 模板库 | 基本设置 |
| `polishPromptInterview` | `""` | `composer.modePromptOverrides.interview` | `promptOverrides.interview` | 该模式的提示词回退来源：模板为空时使用（`briefing-prompts.ts:364` 读 `legacyPromptFieldForMode`） | 无 | 内部（保留存储，不进设置界面） |
| `polishPromptMeeting` | `""` | `composer.modePromptOverrides.meeting` | `promptOverrides.meeting` | 同上（Meeting 模式的回退提示词） | 无 | 内部（保留存储，不进设置界面） |
| `polishPromptHuddle` | `""` | `composer.modePromptOverrides.huddle` | `promptOverrides.huddle` | 同上（Huddle 模式的回退提示词） | 无 | 内部（保留存储，不进设置界面） |
| `polishPromptSeminar` | `""` | `composer.modePromptOverrides.seminar` | `promptOverrides.seminar` | 同上（Seminar 模式的回退提示词） | 无 | 内部（保留存储，不进设置界面） |
| `polishPromptMonologue` | `""` | `composer.modePromptOverrides.monologue` | `promptOverrides.monologue` | 同上（Monologue 模式的回退提示词） | 无 | 内部（保留存储，不进设置界面） |
| `polishPromptLearning` | `""` | `composer.modePromptOverrides.learning` | `promptOverrides.learning` | 同上（Learning 模式的回退提示词） | 无 | 内部（保留存储，不进设置界面） |
| `promptTemplates` | `{…}` | `promptTemplates` | — | 提示词模板库（内置 + 自定义） | AI 整理 | 高级 · 服务 |
| `activeTemplateByMode` | `{…}` | `activeTemplateByMode` | — | 每种模式当前启用的模板 id | AI 整理 | 高级 · 服务 |
| `briefingStructureLevel` | `"balanced"` | `composer.structureLevel` | — | 纪要结构化程度（宽松/均衡/严谨） | AI 整理 | 高级 · 输出 |
| `repolishPreferencePromptAddendum` | `""` | `composer.repolishPreferencePromptAddendum` | — | 「重新整理为」的追加规则 | AI 整理 | 高级 · 服务 |
| `repolishPreference` | `""` | `composer.repolishPreference` | — | 当前选中的重新整理偏好 | 侧边栏 + 右键菜单 | 高级 · 输出 |
| `thinkingMode` | `"auto"` | `composer.thinkingMode` | — | 思考档（auto/reasoning/fast） | 侧边栏 | 高级 · 服务 |
| `briefingTranslationMode` | `"off"` | `composer.languagePolicy.mode` | `languagePolicy.mode` | 纪要语言策略（跟随原文/统一/双语） | AI 整理 | 高级 · 输出 |
| `briefingTargetLanguage` | `"zh-CN"` | `composer.languagePolicy.targetLanguage` | `languagePolicy.targetLanguage` | 目标语言 | AI 整理 | 高级 · 输出 |
| `briefingCustomLanguage` | `""` | `composer.languagePolicy.customLanguage` | `languagePolicy.customLanguage` | 自定义目标语言 | AI 整理 | 高级 · 输出 |
| `briefingKeepOriginalTerms` | `true` | `composer.languagePolicy.keepOriginalTerms` | `languagePolicy.keepOriginalTerms` | 保留专有名词原文 | AI 整理 | 高级 · 输出 |
| `briefingLanguageInstruction` | `""` | `composer.languagePolicy.extraInstruction` | `languagePolicy.extraInstruction` | 额外语言要求 | AI 整理 | 高级 · 输出 |
| `industryProfile` | `{…}` | `composer.industryProfile` | — | 行业档案，由词汇表服务生成 | 内部（程序写入） | 内部（保留存储，不进设置界面） |
| `customVocabulary` | `""` | `vocabulary.inlineTerms` | — | 内联 ASR 热词 | 侧边栏（回退写入） | 高级 · 服务 |
| `vocabularyFile` | `DEFAULT_LIBRARY_PATHS.vocabularyFile` | `vocabulary.notePath` | — | 热词表文件路径 | 资料库 | 高级 · 输出 |
| `peopleDirectoryFolder` | `DEFAULT_LIBRARY_PATHS.peopleDirectoryFolder` | `vocabulary.peopleFolder` | — | 人员资料文件夹 | 资料库 | 高级 · 输出 |
| `peopleBaseFile` | `DEFAULT_LIBRARY_PATHS.peopleBaseFile` | `vocabulary.peopleBasePath` | — | 人员库 .base 文件路径 | 无 | 高级 · 输出 |
| `todoCardsFolder` | `DEFAULT_LIBRARY_PATHS.todoCardsFolder` | `vocabulary.todoCardsFolder` | — | 待办卡片文件夹 | 资料库 | 高级 · 输出 |
| `sedimentAutoExtract` | `false` | `noteNaming.sedimentAutoExtract` | — | 转写/整理完成后是否自动沉淀 | 资料库 | 高级 · 自动化 |
| `basesFolder` | `DEFAULT_LIBRARY_PATHS.basesFolder` | `views.baseFolder` | — | Base 视图文件夹 | 资料库 | 高级 · 输出 |
| `peopleContextMode` | `"privacy"` | `vocabulary.peopleContextMode` | — | 人员资料是否随请求发送（隐私优先/人名热词/本地增强） | 资料库 | 高级 · 诊断与隐私 |
| `peopleHotwordsConsentAt` | `""` | `vocabulary.peopleHotwordsConsentAt` | — | 人名热词授权时间 | 资料库 | 内部（保留存储，不进设置界面） |
| `peopleSuggestionIgnores` | `[]` | `vocabulary.peopleSuggestionIgnores` | — | 已忽略的人员建议 | 关于（只读计数） | 内部（保留存储，不进设置界面） |
| `peopleSuggestionCache` | `{…}` | `vocabulary.peopleSuggestionCache` | — | 待确认人员建议缓存 | 关于（只读计数） | 内部（保留存储，不进设置界面） |
| `knowledgeExtractionHistory` | `{…}` | `vocabulary.extractionHistory` | — | 人员/词表扫描记录 | 关于（只读计数） | 内部（保留存储，不进设置界面） |
| `inboxFolder` | `""` | `storage.inboxPath` | — | 外部收件箱监听目录 | 录音 / 自动导入 | 高级 · 自动化 |
| `inboxAutoImport` | `true` | `storage.autoImportInbox` | — | 是否自动处理新音频 | 录音 / 自动导入 | 高级 · 自动化 |
| `inboxArchiveSubfolder` | `"processed"` | `storage.archiveSubfolder` | — | 处理完成后移入的子文件夹 | 录音 / 自动导入 | 高级 · 自动化 |
| `inboxStabilizeDelayMs` | `3000` | `storage.syncQuietMs` | — | 开始处理前的等待毫秒数 | 录音 / 自动导入 | 高级 · 自动化 |
| `enableInterimOutput` | `true` | `capture.liveSegmentsEnabled` | — | 录音过程中是否切段实时转写 | 录音 / 自动导入 | 高级 · 录音 |
| `segmentIntervalMinutes` | `5` | `capture.segmentMinutes` | — | 切段间隔（分钟） | 录音 + 侧边栏 | 高级 · 录音 |
| `asrConcurrency` | `1` | `speech.asrConcurrency` | — | 导入长音频的并发转写数 | 录音 / 自动导入 | 高级 · 录音 |
| `segmentCacheFolder` | `${NS_ROOT}/.cache/segments` | `storage.segmentCachePath` | — | 分段音频临时缓存目录 | 无 | 高级 · 录音 |
| `keepSegmentAudioFiles` | `false` | `capture.keepSegmentAudioFiles` | — | 是否保留临时分段音频（排障用） | 录音 / 自动导入 | 高级 · 诊断与隐私 |
| `filterShortRecordings` | `true` | `capture.discardVeryShortRecordings` | — | 短录音保护：3 秒内丢弃，3–10 秒只留音频不建纪要 | 录音 / 自动导入 | 高级 · 录音 |
| `captureMode` | `"mic"` | `capture.sourceMode` | — | 录音来源（麦克风/混合/电脑音频） | 常规 + 侧边栏 | 基本设置 |
| `audioChannelMode` | `"auto"` | `capture.channelMode` | — | 是否按声道区分说话人 | 录音 | 高级 · 录音 |
| `selectedVirtualDevice` | `""` | `capture.virtualDeviceId` | — | 电脑音频输入设备 id | 录音 | 基本设置 |
| `selectedMicrophoneDevice` | `""` | `capture.microphoneDeviceId` | — | 麦克风设备 id | 录音 | 基本设置 |
| `enableRealtimeOutline` | `true` | `liveOutline.enabled` | — | 转写后是否自动更新实时大纲 | 录音 / 自动导入 | 高级 · 输出 |
| `realtimeOutlineDebounceMs` | `2500` | `liveOutline.debounceMs` | — | 实时大纲请求防抖毫秒数 | 无 | 高级 · 输出 |
| `autoOpenOutlineOnRecord` | `true` | `liveOutline.openOnCapture` | — | 录音开始时是否自动打开侧边栏 | 录音 / 自动导入 | 高级 · 输出 |
| `autoRenameWithTitle` | `true` | `noteNaming.renameWithTitle` | — | 是否用 AI 提炼主题追加到文件名 | 录音 / 自动导入 | 高级 · 输出 |
| `consolidatedLayout` | `true` | `noteNaming.consolidatedLayout` | — | 纪要是否整合排版（顶部整合、底部原始分段） | 录音 / 自动导入 | 高级 · 输出 |
| `maxRetries` | `3` | `retryPolicy.maxAttempts` | — | 转写/整理任务的自动重试上限 | 录音 / 自动导入 | 高级 · 自动化 |
| `diagnosticsLogEnabled` | `true` | `diagnostics.enabled` | — | 是否写本地诊断日志 | 录音 / 自动导入 | 高级 · 诊断与隐私 |
| `diagnosticsLogFolder` | `DEFAULT_LIBRARY_PATHS.diagnosticsLogFolder` | `diagnostics.folder` | — | 诊断日志目录 | 录音 / 自动导入 | 高级 · 诊断与隐私 |
| `showFloatingBall` | `true` | `ui.floatingControlEnabled` | — | 是否常驻显示桌面悬浮按钮 | 常规 + 命令面板 | 高级 · 自动化 |
| `bubbleSize` | `"large"` | `ui.bubbleSize` | — | 悬浮按钮大小 | 录音 | 高级 · 自动化 |
| `floatingBallPos` | `{…}` | `ui.floatingControlPosition` | — | 悬浮按钮位置（拖动写入） | 录音（拖动写入） | 内部（保留存储，不进设置界面） |
| `autoOpenNoteAfterFinish` | `true` | `noteNaming.openAfterFinish` | — | 处理完成后是否自动打开纪要 | 录音 | 高级 · 输出 |
| `autoOpenHtmlReportAfterGenerate` | `true` | `presentation.openHtmlReportAfterGenerate` | — | 生成 HTML 报告后是否用浏览器打开 | AI 整理 | 高级 · 输出 |
| `writeDailyMeetingOverview` | `true` | `dailyNote.meetingOverviewEnabled` | — | 是否把会议概要写入当日日记 | 录音 | 高级 · 输出 |
| `dailyMeetingOverviewHeading` | `DEFAULT_DAILY_MEETING_OVERVIEW_HEADING` | `dailyNote.meetingOverviewHeading` | — | 写入日记的标题 | 录音 | 高级 · 输出 |
| `dailyMeetingOverviewTemplate` | `DEFAULT_DAILY_MEETING_OVERVIEW_TEMPLATE` | `dailyNote.meetingOverviewTemplate` | — | 写入日记的模板 | 录音 | 高级 · 输出 |
| `autoCheckUpdates` | `true` | `updates.autoCheck` | — | 启动时是否检查新版本 | 关于 | 高级 · 自动化 |
| `lastUpdateCheckAt` | `null` | `updates.lastCheckedAt` | — | 上次检查更新时间 | 关于（只读展示） | 内部（保留存储，不进设置界面） |
| `availableUpdate` | `null` | `updates.available` | — | 已发现的可用更新 | 关于（只读展示） | 内部（保留存储，不进设置界面） |
| `lastUpdateError` | `""` | `updates.lastError` | — | 上次检查失败原因 | 关于（只读展示） | 内部（保留存储，不进设置界面） |
| `installedUpdateVersion` | `""` | `updates.installedVersion` | — | 当前已安装版本记录 | 内部（程序写入） | 内部（保留存储，不进设置界面） |

### 9.2 设置结构（2026-09-15 执行）

六个面向用户的选项卡，按「用户此刻想做什么」划分，不按代码模块划分。
判据是**语音记录优先**：与「录到什么」直接相关的项排在前面，旁路功能另置一页。

| 选项卡 | 分组 | 设置项 | 动作行 |
|---|---|---:|---:|
| 录音 | 音频输入 / 录音与转写 / 纪要与实时大纲 / 文件与命名 / 完成后动作 / 悬浮按钮 | 18 | 1 |
| API | API 配置 / 语音识别 / AI 整理 / 说话人识别 | 16 | 3 |
| AI 整理 | 纪要生成 / 语言与翻译 / HTML 报告 / 纪要模板 | 6 | 1 |
| 资料库 | 资料库 / 补全与去重 / 浏览与维护 / 存储与隐私 | 6 | 5 |
| 自动导入 | 自动导入音频 / 任务重试 | 5 | 3 |
| 关于 | 插件更新 / 诊断与日志 | 3 | 5 |

本轮的三处调整：

1. **拆掉「进阶」选项卡**。它原本 16 项挤在 5 组里，里面混了三类东西：
   录音参数（分段间隔、并发、短录音过滤）、旁路功能（自动导入收件箱）、排障（诊断日志）。
   拆分后：录音参数进「录音」——它们直接决定录到了什么，是常项而非边角设置；
   自动导入与任务重试合成「自动导入」（都属「不在场时自动发生的事」）；
   诊断日志进「关于」。
2. **「常规」改名「录音」**。原名的「常规」什么都没说；这一页的实际内容是
   声音怎么进来、存到哪里、录完发生什么，改名后名实相符。
   分组顺序也按这个顺序重排，把「音频输入」放在最前。
3. **「更新」扩为「关于」**。更新、诊断日志、版权与许可三者都不是配置项
   （全会话只有「启动时自动检查」一个开关），原先分散在两处，现集中一页。

「说话人」选项卡并入「API」见 §11.8。首页「使用状态」见 §11.7。

**不动的部分**：「AI 整理」与「资料库」两页本轮只保留现状。前者的四个分组
（纪要生成 / 语言与翻译 / HTML 报告 / 纪要模板）围绕「生成什么内容」，
后者围绕「沉淀与复用」，各自内聚，没有跨页重复。



三层，判据是「改了它会不会立刻影响用户拿到什么」：

| 层 | 放什么 | 键数 |
|---|---|---:|
| 基本设置 | 当前服务与状态、更换密钥、录音来源、笔记保存位置、默认整理方式 | 11 |
| 高级设置 | 自定义地址与模型、分阶段服务、提示词、分段与并发、重试、命名、日记、自动导入、诊断 | 56 |
| 帮助与关于 | 配置说明、排障、版本与许可 | 0（全是展示项，无设置键） |
| 内部（保留存储） | 程序生成或由其它界面/流程写入，不出现在设置界面 | 20 |

「高级」内部按 **服务（11）/ 录音（6）/ 输出（26）/ 自动化（9）/ 诊断与隐私（4）** 五组划分，避免变成长列表。

11 + 56 + 20 = 87，与 §9.1 的键数一致。

**录音来源、保存位置、默认整理方式留在基本设置**，不放进高级：这三项直接决定用户录到了什么、
文件在哪里、生成什么内容，属于第一次使用就要确认的项。其余个性化设置（自定义地址与模型、提示词、
分段与并发、重试、命名规则、日记集成、自动导入、诊断）进高级。

有 20 个键标为「内部」：它们要么由程序写入（`floatingBallPos` 由拖动写、`availableUpdate` 由更新检查写、
`knowledgeExtractionHistory` 由扫描写、`lastUpdateCheckAt` 等由更新服务写），要么是历史兼容字段
（`transcribeEndpoint` 等 4 个兼容兜底、`polishPrompt*` 6 个模板迁移来源），要么只作展示
（`peopleSuggestionCache` 等的计数）。**它们继续参与落盘与读回，只是不再占用设置界面**——
删掉会丢用户数据，这一点在 §9.3 的约束 2 里写明。

### 9.3 维护规则冲突

分两类：**实现冲突**（同一件事有两套实现）与**材料冲突**（文档写的与代码行为不一致）。
材料冲突里只做事实性更正的部分已在任务 0 顺手修掉；实现冲突中与配置/检测相关的四条（2、3、4）
与「检测并保存」一条，已在任务 1 处理，见 §9.6。

#### 9.3.1 实现冲突

| # | 冲突 | 证据 | 状态 |
|---|---|---|---|
| 1 | **首页有两个推荐入口，指向不同服务。** 「使用推荐配置」写入硅基流动，页内「快速设置」默认选中小米 MiMo，两者都能一键落地 | `settings-tab.ts` 的 `applyBeginnerDefaults`（写 `siliconflow`）与 `oneCardProviderId = "mimo"` | **未动**：两者现已共用同一份计划计算（见 §9.6），但默认选中哪一家仍待核实后再定（§9.4） |
| 2 | **同一项配置的写入逻辑有两套。** 「API」页的 `writeProvider` 会同步进当前 API 方案，首页「快速设置」走自己的 `applyOneCardProvider`；两处都写 `transcribeProviders` | 原：API 页 `writeProvider` 调 `syncWorkingAsrToActiveScheme`、说话人页的 `writeProvider` 不同步、`applyOneCardProvider` 另写一套 | **已合并**：三条路径都经 `src/setup` 的 `planPresetApplication` / `applyPresetPlan`；「说话人页不同步方案」的差异保留为显式行为（它只改导入服务） |
| 3 | **连通性检测有四份实现。** 转写测试、组合测试、导入服务测试、大模型测试各一套；首页「快速设置」还另建 `probePlugin` 影子对象来测未保存的输入 | 原四处检测 + 两处 `probePlugin` 影子对象 | **已统一**：`runPresetDetection` 一处组装，端口由 `probePorts()` 提供一次；检测对象改为候选配置 |
| 4 | **API 方案的应用逻辑有两套，行为不同。** 「API」页调 `applyLlmProfileToWorkingConfig`（会一并切换方案里的转写快照），「说话人」页把同一段逻辑内联抄了一遍（不切换转写） | 原：API 页调 `applyLlmProfileToWorkingConfig`，说话人页内联抄了一遍 | **未动**：`applyLlmProfileToWorkingConfig` 自己的逻辑已有一份（`llm/config.ts:264`），但说话人页那段内联副本仍在，属任务 2 的页面重排范围 |
| 5 | **「说话人」页同时放导入音频与 AI 整理服务配置。** 页内有「导入音频」和「AI 整理」两个一级标题，后者还提供「完整设置」跳到 API 页 | `settings-tab.ts` 的 `renderSpeaker` 页内含「导入音频」与「AI 整理」两个一级标题 | **未动**：属任务 2（页面重排） |
| 6 | **首页状态判断分不清「已填写」与「测试通过」。** 只检查字段非空；服务页的徽章文案同样写「已填写」 | 原只看字段非空，服务页徽章写「已填写」 | **已改**：改为四态（缺配置 / 未测试 / 已通过 / 未通过），见 §9.6 |

#### 9.3.2 材料冲突（文档与代码不一致）

| # | 冲突 | 证据 | 状态 |
|---|---|---|---|
| 7 | **README 与实现相反。** 两份 README 都写「版本不一致就丢弃设置、改用默认值」，而 1.0.0 起已改为向前迁移、保留用户数据（`foreign` 才丢弃，且先留档） | `README.md:183`、`README.zh-CN.md:201`（改前） vs `shared/settings-schema.ts` 与 `main.ts:442-455` | **已修正**（两份 README 同步改写） |
| 8 | **`settings-io.ts` 头部的政策注释过期。** 仍写「版本号与当前值不一致时一律丢弃」，与 §4.5 的四态判定矛盾 | `src/shared/settings-io.ts` 的 `SETTINGS_SCHEMA_VERSION` 上方注释（改动前为第 33–34 行） | **已修正**（改为指向 §4.5 的四态） |
| 9 | **`MAINTAINING.md` 的章节编号乱序。** 「功能边界」编成 7 却排在 6 之前；另有一条悬空引用「按 §9 仍不进仓库」，而 §9 当时不存在 | 章节顺序：功能边界排在待办之前，编号却是 7 与 6；悬空引用在改动前为 `MAINTAINING.md:557` | 悬空引用**已修正**；编号乱序未动（牵动多份交叉引用，单独批次处理） |
| 10 | **`MAINTAINING.md` 待办里有两条已完成。** 「设置页静默改写 `importTranscribeProvider`」已在 `renderSpeaker` 改为只读借用 + 页面说明；「自定义服务的密钥必填判定」已按 endpoint 推断 | 待办清单「第一条」下两条（改动前为 `MAINTAINING.md:561`、`:562`）vs `settings-tab.ts:1436`、`transcribe-profile-service.ts:253` | **已勾掉** |
| 11 | **`DESIGN_SPEC.md` 的颜色规范已失效。** 全文 32 处引用 `--lex-*`，而 `styles.css` 有 68 个 `--qnalog-*`、0 个 `--lex-*`，源码里没有 `--lex-` 读取方 | `DESIGN_SPEC.md` 第 2 节「颜色系统」（第 17–60 行）vs `styles.css` | **未改**：其中 `--lex-border-line-hover`、`--lex-bg-active-strong` 在 `styles.css` 里连 `--qnalog-*` 对应项都不存在，需先确认是被删除还是改了名，不能机械批量替换 |


#### 9.3.3 同批发现的两处命名与死代码

不构成规则冲突，但属于同一批该清的东西：

- **两个旧前缀标识符。** `src/ui/settings-tab.ts:71` 的 `LV_SETTINGS_TABS` 与
  `src/views/base-definitions.ts:6` 的 `LV_BASE_DEFINITIONS` 仍用旧前缀。`check:legacy-prefixes`
  的正则要求前缀后跟连字符（`lex-` / `lv-` / `lvk-`），因此拦不住这种裸 `LV_` 常量名——
  该门禁的覆盖范围到此为止，不要以为它绿了就没有旧前缀。
- **三个方法没有调用方。** `addFolderPathSetting`（`settings-tab.ts:2253`）、
  `getAllVaultFolderPaths`（`:2241`，仅被前者调用）、`restoreTranscribeProviderDefaults`（`:298`）。
  三者都只在本文件内出现，删除不影响任何调用点。

### 9.4 本轮不决定的事

- **推荐哪家服务**：需要另行核实服务能力、模型可用性、地区与费用，不凭代码里的默认值（硅基流动）直接决定。
- **`first` 层只有一个入口**：由 §9.3 冲突 1 合并而来，具体保留哪一个待推荐方案确定后再定。

### 9.5 改造约束（本轮已确认）

1. 一批只解决一个明确问题；设置页改造不夹带录音流水线重构。
2. **配置只有一套实际存储**（`data.json` 的 `settings` 分组）。简单界面与高级界面读写同一批字段，
   不引入第二套同步逻辑，也不新增影子副本。
3. **预设只包含完成服务配置所需的值**（地址、模型、密钥）；不顺手覆盖目录、提示词、设备与自动化偏好。
4. **同一项配置的修改与检测逻辑只实现一次**（对应 §9.3 冲突 2、3、4）。
5. 不引入通用表单框架、预设市场或新依赖。
6. 按本次改动需要拆出**有类型检查的小模块**；不以清除 `settings-tab.ts` 的 `@ts-nocheck` 为前置任务
   （该文件当前在 §8 的暂停清单里）。
7. **测试覆盖用户后果**：错误密钥、部分服务失败、取消配置、重启后读回、已有配置被保留。
   设置结构变更仍按 §4.5 的三步走（版本号 +1、登记迁移、加用例），并遵守同一节的四态判定。

---

## 10. 首次配置：预设范围、检测与四态

任务 1 的产物。对应的实现在 `src/setup/index.ts`（有类型检查），行为测试在 `tests/setup.test.ts`。

### 10.1 预设改哪些字段

预设**只写完成服务配置所需的键**，清单集中在 `PRESET_WRITTEN_FIELDS`：

| 写入 | 键 |
|---|---|
| 是 | `transcribeProviders`、`activeTranscribeProvider`、`importTranscribeProvider`、`importSpeakerDiarization`、`llmServicePreset`、`llmEndpoint`、`llmModel`、`llmApiKey`、`llmProfiles`、`activeLlmProfile` |
| 否 | 其余 77 个键，含目录、提示词、录音设备、分段与并发、重试、诊断、日记、自动导入 |

`tests/setup.test.ts` 会拿一份「用户已经改过很多项」的设置逐键核对：清单之外的键必须逐项不变。
反向验证过——一旦让预设顺手写 `audioFolder`，该用例立刻失败。

两条容易被忽略的边界：

- **不改用户已选的转写语言**：预设填地址、模型、密钥，`language` 只在用户没设过时才用默认值。
  用户把语言调成 `en` 之后套预设，仍是 `en`。
- **说话人识别按供应商差异化**：预设自带导入服务（百炼 / OpenRouter，含说话人识别模型）写为启用；
  否则写为未启用（例如小米 MiMo 没有说话人识别模型）。该键的默认值也是未启用。
- **密钥为空时不覆盖**：「先套推荐配置、再填密钥」的入口（`allowMissingKey`）只写地址与模型，
  不会把用户已填的密钥清成空串。

### 10.2 检测对象是候选配置

检测分三步：`planPresetApplication` 算出计划 → `applyPresetPlan` 得到候选设置 →
`buildProbeHost` 用它构造检测宿主。因此**测的是用户正在填的值**，不是磁盘上已保存的配置。

`buildProbeHost` 的 `saveSettings` / `saveAll` 指向拒绝函数（不是删掉）：
检测若试图写盘会直接失败并报「检测过程不得写盘」，而不是静默保存。
用户点「检测」不等于同意保存。

### 10.3 四态

| 状态 | 含义 | 判定 |
|---|---|---|
| 缺配置 | 端点、模型或（云端服务的）密钥没填 | `setupServiceIssue` 非空；本地服务可省密钥 |
| 未测试 | 填全了，但没有同配置的测试结果 | 无结果、或配置指纹已变 |
| 已通过 | 同配置最近一次检测成功 | 结果 `ok` 且指纹一致 |
| 未通过 | 同配置最近一次检测失败 | 结果不 `ok` 且指纹一致 |

**「指纹」指端点 + 模型 + 密钥摘要**（密钥只进散列不进原文）。改了任一项，旧结果自动失效、
回到「未测试」——不需要在每个输入框上挂重置逻辑。结果只存在内存（`_probeResults`），不落盘：
它表示「本次会话测过没有」，不是用户配置。

界面上的体现：服务页徽章用这四态，不再显示含糊的「已配置 / 已填写」。
徽章只用已有的 `is-ready` / `is-missing` 两种配色，四态差别由文字承担（颜色区分在色弱下不可靠）。
首页「程序状态」不参与这四态——它只看是否缺配置（§11.7），两者职责不同不要合并。

### 10.4 取消与失败不覆盖已有配置

- **取消**：计划是纯函数（不改传入对象），应用前丢弃计划即可，磁盘逐项不变。
- **检测失败**：只记录结果，不写入任何设置；用户已填的密钥不被清空。
- **未点「应用」**：不会有任何写盘调用。

以上四条都有用例，且逐条做过反向验证（故意破坏实现后对应用例失败）。

### 10.5 仍未处理的

- §9.3 冲突 1（首页两个推荐入口各指向一家服务）：两者已共用同一份计划计算，
  但**默认选中哪家**仍未定——需先核实服务能力、模型可用性、地区与费用（§9.4）。
- §9.3 冲突 4 的说话人页内联副本、冲突 5 的页面命名与拆分：属页面重排（任务 2）。
- 设置页的 `@ts-nocheck` 仍在（§8 的暂停清单）；本次新增逻辑都放在有类型检查的 `src/setup/` 里，
  设置页只保留 DOM 与事件绑定。

---

## 11. 首次配置：阿里云百炼一站式方案

任务 2 的产物。首次配置只保留**一条**路径：填阿里云百炼的 API Key。
服务地址与三个模型全部内置，用户不需要看到、也不需要选择它们。

### 11.1 内置的三段服务与模型

| 用途 | 服务（provider id） | 模型 | 接入方式 |
|---|---|---|---|
| 录音转写（分段） | `dashscope-chat` | `qwen3-asr-flash` | HTTP（OpenAI 兼容）`/compatible-mode/v1/chat/completions` |
| 导入音频（整文件） | `dashscope-filetrans` | `qwen-audio-3.0-asr-flash-filetrans` | DashScope 异步 `/api/v1/services/audio/asr/transcription` |
| AI 整理 | 服务预设 `dashscope` | `qwen3.8-flash` | OpenAI 兼容 `/compatible-mode/v1` |

三段共用同一把密钥，写入范围仍受 §10.1 的 `PRESET_WRITTEN_FIELDS` 约束。

**录音转写为什么不用实时流式**（2026-09-17 改动）：

原选用的 `qwen-audio-3.0-asr-flash-streaming` 走 WebSocket 实时识别，
鉴权只能通过 `Authorization` 请求头传递（官方 Python / Java / Node 三种示例均为自定义请求头；
文档中 `Sec-WebSocket-Protocol` 出现 0 次，查询参数传密钥也是 0 次）。
但浏览器的 `WebSocket` 构造器不接受请求头——第二参数是子协议字符串，
传对象会抛 `SyntaxError: Failed to construct 'WebSocket': The subprotocol '[object Object]' is invalid`。
插件因此只能用 Node 的 `ws` 包，而 Obsidian 移动端不提供 Node 模块
（`scripts/check-mobile-bundle-load.mjs` 的沙箱会拒绝 `require("ws")`）。
**结论：实时流式在移动端是规范级的死路，与模型和地址无关。**

改用 `qwen3-asr-flash` 后桌面与移动端走同一条 HTTP 路径，一次配置两端可用。
代价是失去「边说边出字」——但整段音频能容纳说话人自己的纠正
（例如说完专有名词后逐字母拼读），实时流式在用户读出字母时已把前句定稿，拿不到这份信息。

**模型与接入方式的核实依据**（2026-09-17 查阿里云百炼「语音识别概述」与「非实时语音识别（Qwen-ASR）API 参考」）：

- `qwen3-asr-flash` 在模型表中标注为「非实时 / HTTP（OpenAI 兼容）」，
  单次上限「5 分钟 / 10MB」。
- 请求形状为 `POST {base}/chat/completions`，body 里
  `messages[].content[].input_audio.data` 取 `data:{MIME};base64,...`；
  与既有 `apimimo` 协议同形状，因此复用同一条实现（`src/asr/transcribe.ts`），只按服务取参数。
- 文档要求语种不确定时**省略** `asr_options.language`，不能填 `auto`；
  MiMo 则要求始终下发（含 `auto`）。这是两者唯一的协议差异点。
- 响应正文在 `choices[0].message.content`（非流式）或 `choices[0].delta.content`（流式），
  与既有解析一致。
- 上限「10MB」按十进制 10,000,000 字节取值：文档没写清是哪一种 MB，取更严的那个。
  切块尺寸因此定为 3 分钟（16kHz 单声道 16-bit WAV = 32,000 字节/秒，
  3 分钟 base64 后约 7.68MB；4 分钟即达 10.24MB 超限）。
- `qwen-audio-3.0-asr-flash-filetrans` 与 Fun-ASR 同为**异步调用**，用 `file_urls`、
  `X-DashScope-Async: enable`、轮询 `/api/v1/tasks/{id}`——与既有 `dashscope-filetrans` 实现一致，
  因此沿用该协议，未新增协议分支。
- `qwen-audio-3.0-asr-flash-streaming` 走实时识别的 WebSocket 协议
  （`run-task` → `result-generated` → `finish-task`），与既有 `dashscope-ws` 实现一致。
  该条目保留在设置里，桌面用户仍可手动选用。
- 该模型支持 `language_hints`（最多 4 个值）、`format`、`sample_rate`。

**对既有用户的影响**：预设只在用户于设置界面主动点「保存并启用」时才写入
（`src/setup/index.ts` 的 `planPresetApplication` 由 `src/ui/settings-tab.ts` 调用，加载时不触发），
因此已经在用 `dashscope` 实时流式的用户不受影响，配置不会被改写。

### 11.2 顺带修掉的协议缺陷（`src/asr/realtime-params.ts`）

查证文档时发现既有实现会**无条件下发 `disfluency_removal_enabled`**。
该字段在文档里明确标注「仅 Paraformer 支持」，
Qwen-Audio-3.0-ASR-Flash-Streaming / Fun-ASR-Realtime 的参数表中没有它。
旧实现还无条件下发 `language_hints: ["zh","en"]`，对未指定语种的用户是替服务端做了决定。

现在只有 Paraformer 系列才下发 `disfluency_removal_enabled`；
`language_hints` 仅在用户指定了语种时下发，否则交给服务端自动识别。
参数构造移入有类型检查的 `src/asr/realtime-params.ts`，由 `tests/realtime-params.test.ts` 覆盖
（反向验证过：恢复旧行为会让三条用例失败）。

**未改动**：paraformer 系列仍按原样工作；用户的既有服务配置与模型选择没有任何变更。

### 11.3 界面

首页「快速设置」只剩一个输入框（百炼 API Key）与两个按钮（保存并启用 / 仅检测）。
点「保存并启用」时先检测候选配置，**检测未全部通过就不落盘**——避免把一把无效密钥当成配置写进去。

原先首页有两个各指向不同服务的推荐入口（「使用推荐配置」写硅基流动、「快速设置」默认小米 MiMo），
已合并为一条：「使用推荐配置」现在只是滚动到「快速设置」并说明该填什么。

### 11.4 已知限制

- **录音转写不再是移动端限制。** 一站式方案现在用非实时的 `qwen3-asr-flash`（HTTP），
  桌面与移动端走同一条路径。原先的实时流式模型在移动端不可用（无法给 WebSocket 设鉴权头），
  该条目仍保留在设置里供桌面用户手动选用，移动端选中它时会提示改用分段服务。
- 录音转写失去「边说边出字的实时流」。分段仍按分段间隔逐段出字（间隔默认 5 分钟）。
  单段超过服务端单次上限（5 分钟 / base64 后 10MB）时，插件在本机解码并切成 3 分钟以内的块后上传；
  MediaRecorder 录的 webm/opus 体积远小于 WAV，5 分钟的段通常可原样直发，不触发切块。
- 百炼一站式方案需要用户在百炼控制台**开通对应模型**，否则检测会失败并如实报出是哪个环节。

### 11.5 真机验证发现的两处修正（2026-09-15）

首次用百炼一站式方案做真机验证时暴露的问题，均已修：

**① 检测把 `wss://` 按 HTTP 校验，误报「协议不受支持」。**
百炼录音转写是 WebSocket 服务（`wss://…/api-ws/v1/inference`），
而 `transcribeAudio` 内的校验写死 `"http"`，于是地址被当成协议不受支持而失败——
服务本身完全正常，用户看到的却是一段红色的失败提示。

原因不只是校验传参：**检测本身走错了链路**。流式服务的真实使用方式是
「录音时建 WebSocket 并握手鉴权」，而检测此前一律走 HTTP 上传一段静音音频，
既与真实链路不符，也会被 HTTP 校验拦下。

修法（两层，都在 `src/shared/util-llm-endpoint.ts` 与设置页）：

- 新增 `inferEndpointTransport` / `describeEndpointIssue` / `assertEndpointAllowed`：
  **按地址自身的协议校验**（`ws://`/`wss://` 走 websocket 规则，其余走 http 规则）。
  安全规则没有放宽——公网明文 `ws://` / `http://` 仍被拒绝。
- `runAsrConnectivityTest` 改为按服务实际传输方式分流：流式服务走真实 WebSocket 握手
  （服务端在握手阶段校验密钥），其余仍走上传。流式检测不发送音频，因此不产生识别计费。

**② 首页四个按钮、且已配好仍显示快速配置面板。**
按维护者要求收敛为两个动作：**快速配置**、**打开侧边栏**。
「配置服务」「AI 整理设置」两条跳转已移除——分别跳 API 页与 AI 整理页，
四个按钮并列时用户无法判断该点哪个；细节调整在各页面里本来就有入口。

快速配置面板默认在**已配好（转写与 AI 整理都不缺）时不再显示**；
此时点「快速配置」会先弹确认（说明会覆盖哪三段、不会动哪些），确认后才显示面板。
初次配置不弹确认，直接显示。

回归防线：`tests/endpoint-transport.test.ts`（5 项）钉住按协议校验，
其中一条直接断言「旧实现按 http 校验会误报协议不受支持」；
`tests/bailian-setup.test.ts` 补两项钉住面板显示条件。

### 11.6 真机验证第二轮：切换服务后的历史分段任务（2026-09-15）

**现象**：快速设置里三段检测全部通过，但执行转写任务仍报同一句
「转写服务地址协议不受支持」。

**根因不在检测，在队列里的历史任务。**

Fresh 库的时间线（文件系统的修改时间可查）：

| 时间 | 事件 |
|---|---|
| 17:49:45 | 装入含本次修复的构建 |
| 17:50:53 | 开始录音。**此时配置还没落地**，用的是默认的硅基流动（`https://`），因此录音按段切开 |
| 17:51:17 | 停止录音，两段进入转写队列（`providerId: null`） |
| 17:54:24 | 执行快速设置，配置换成百炼实时转写（`wss://`）；随后队列重试 |

分段任务本身不记录「当初用的是哪个服务」（`providerId: null`），
重试时 `transcribeAudio` 按**当前**激活服务解析 provider，于是拿着 `wss://` 地址走 HTTP 上传，
被协议校验判为不受支持。检测通过、转写失败，是因为这两件事用的是不同时刻的配置。

**修法**：分段重试前先判断当前服务能不能接受「已录好的分段」。
流式服务只能在建连时逐帧推流，无法把分段 POST 上去，因此直接给出可行动的说明，
而不是让它去撞协议校验、报一句与真实原因无关的错：

> 当前转写服务是流式服务（阿里云百炼实时转写），不能逐段重试——流式服务只支持录音时
> 实时推送，无法把已录好的分段上传转写。请在「API」页改用分段或整文件转写服务，
> 或在会话笔记里对整场录音重新转写。

判定逻辑在 `describeSegmentRetryUnavailable`（`src/queue/queue-retry-service.ts`），
由 `tests/segment-retry-guard.test.ts` 覆盖。取不到服务档案时**不拦**——
探测失败不该让重试彻底不可用。

**已验证新录音不再复现**：用 Fresh 库的真实配置跑一遍录音前的分段判定，
`transcribeMode = streaming` → `segmentDurationMs = 0` → 整场流式推送，不产生分段任务。

**未做**（登记，不在本轮范围）：让历史分段任务真正恢复。可行方向是用已保留的整场录音
（`masterAudioPath`，本次录音的母带完好）走整文件转写重新获得文本；这会改变分段语义，
按「一批只解决一个明确问题」留到单独批次。

**给使用者的处置**：这类历史任务重试不会成功，在队列面板逐条「取消」即可；
重新录一段音频即可验证新链路。

### 11.6.1 音频设备识别与选择

「麦克风」与「电脑音频」两个下拉共用一个分类函数（`classifyAudioInputDevices`、
`pickComputerAudioDevices`，`src/ui/helpers.ts`），判据一致：

| 下拉 | 列出什么 | 为什么 |
|---|---|---|
| 麦克风 | **全部**输入设备，按名字分组（默认 / 麦克风 / 虚拟声卡 / 当前选择） | 用户可能就想用虚拟声卡录人声；实体麦克风名字里也可能带 SoundWire 之类关键词。过滤会把真麦克风弄丢，所以只分组、不删项。 |
| 电脑音频 | 正常只列虚拟声卡；**一个都认不出时退回列出全部** | 电脑音频要的是虚拟声卡输入。但关键词表只是启发式，认不出时若照旧只列虚拟声卡会得到空列表，比多列几只更难用。 |

**两者都不做自动选择。** 判定哪只是虚拟声卡靠设备名关键词，判错就会录到错误的声音，
而用户从界面上看不出来。所以一律留空让用户手动选，下拉里标「推荐 · 虚拟声卡」供参考。
原先「自动设置」按钮会写 `selectedVirtualDevice`（`autoConfigureAudioInput`），已移除该行为，
按钮只保留「测试设备」与「设置电脑音频」。

**「名字读不到」不等于「没有设备」。** `enumerateDevices()` 在未授权时仍会返回设备与
`deviceId`，只有 `label` 是空的。因此：

- 有设备、名字全空 → 提示「设备名需授权才能显示（读到 N 个设备）」，并说明仍可按下拉顺序选；
- 一个输入设备都没有 → 才说「未检测到音频输入设备」。

把前者当后者会让用户看到「未检测到设备」而实际只是没授权。

**权限申请只在用户动作里发生。** `enumerateAudioDevices({ requestPermission: true })`
会调一次 `getUserMedia` 拿设备名；不传则只调 `enumerateDevices()`，不弹授权框、
不点亮系统麦克风指示灯。调用点分两类：

| 场景 | 是否申请权限 | 理由 |
|---|---|---|
| 首页「使用状态」读设备 | 否 | 只看状态却弹出麦克风授权请求，用户会以为插件在录音 |
| 麦克风 / 电脑音频下拉 | 是 | 要显示设备名才能选，用户打开设置页就是为了选设备 |
| 「检测设备」「测试设备」「自动设置」「重新检测」 | 是 | 用户主动发起的检测 |

### 11.7 首页「使用状态」

首页这块只回答两个问题：**现在能不能开始用？如果能，当前会用什么服务？**

```
使用状态

已准备好
核心配置已完成，可以开始录音。

语音转写                            ›
阿里云百炼实时转写
qwen-audio-3.0-asr-flash-streaming
─────────────────────────────────
AI 整理                             ›
阿里云百炼 / DashScope
qwen3.8-flash
─────────────────────────────────
说话人识别                          ›
已启用
qwen-audio-3.0-asr-flash-filetrans
─────────────────────────────────
音频输入                            ›
MacBook Pro 麦克风 · 可用
系统默认
```

**正常状态不显示任何状态标记。** 每行都挂一个相同的标记等于没有信息量，
还会把注意力从真正有问题的那行拉走。因此 `SetupStatusLine.icon` 正常时为空字符串，
只有异常行才渲染 `!`（缺配置）或 `×`（已确认不可用，比缺配置更严重——
用户以为配好了，实际用不了）。总体结论也不放圆点：四个单项已经各自说明了状况，
总结再挂一个同样的标记只是重复；没准备好时右上角出现一个徽章。

**视觉层级依次是：结论 → 配置项名称 → 服务名 → 模型 ID。**
紫色只用于真正的交互（hover、focus、当前选中），不用于静态文字——
把标题和服务名都染成 accent 会让普通信息看起来像链接，也把层级压平。

| 元素 | 颜色 | 字号 |
|---|---|---|
| 结论 | `--text-normal` + semibold | `--font-ui-medium` |
| 配置项名称 | `--text-normal` + semibold | `--font-ui-small` |
| 服务名 | `--text-normal` | `--font-ui-small` |
| 模型 ID | `--text-muted` + `--font-monospace` | `--font-ui-smaller` |

**整行都是点击目标**，右侧箭头只是「这一行能点」的提示，因此保持低存在感
（`--text-faint`、`opacity: 0.55`，hover 时才提亮）。
跳转目标：语音转写 → `api`、AI 整理 → `ai`、说话人识别 → `api`、音频输入 → `recording`。

**条目之间只用低对比度分隔线**（`--background-modifier-border`），不画表格、不加卡片背景。
四项放在一个容器里（`.qnalog-status-list`），保持 Obsidian 设置页的克制感，
不做成 SaaS dashboard 那种组件。

**判定口径**：只有语音转写与 AI 整理缺配置才拦得住「开始使用」，
因此 `blockerCount` 与 `headline` 只算这两项，徽章用同一个数；
不拦住开始使用、但仍需处理的项目（如所选的麦克风已断开）放在 `warnings` 里单独计数。
两者口径若混在一起，会出现「说还差 2 项、但结论又是已准备好」。
测试结果完全不参与（那属于 §10.3 的四态）。

**音频输入行显示用户读得懂的短名**：浏览器给的原始 label
（`Default - MacBook Pro Microphone`、`MacBook Pro麦克风 (Built-in)`）既是调试态、
又中英混杂，因此 `friendlyDeviceName` 去掉系统默认前缀；认不出的原样返回，
宁可显示长一点，也不猜成一个不准确的短名。次级行写「系统默认」或「已指定设备」，
不重复模式名——「音频输入」这一行已经表达了输入来源。

数据来自 `buildSetupStatus`（`src/setup/index.ts`，有类型检查），
由 `tests/bailian-setup.test.ts` 的 9 项覆盖，含反向验证。

---

## 12. 首次配置：OpenRouter 一站式方案

面向中国大陆以外用户：一把 OpenRouter Key 配好「录音转写 / 导入音频 / AI 整理」三段。
与百炼并存于快捷配置的下拉里，由用户按网络环境自选——
两者的区别是「能不能连上」，不是界面语言。

### 12.1 内置的三段服务与模型

| 用途 | 服务（provider id） | 模型 | 接入方式 |
|---|---|---|---|
| 录音转写（分段） | `openrouter` | `qwen/qwen3-asr-1.7b` | OpenAI 兼容 `/api/v1/audio/transcriptions`（multipart） |
| 导入音频（整文件，带说话人分离） | `openrouter-diarize` | `microsoft/mai-transcribe-2` | 同一端点，JSON 正文 + `provider.options` |
| AI 整理 | 服务预设 `openrouter` | `deepseek/deepseek-v4.1-flash` | OpenAI 兼容 `/api/v1` |

三段共用同一把密钥，写入范围仍受 §10.1 的 `PRESET_WRITTEN_FIELDS` 约束。

**模型与接入方式的核实依据**（2026-09-16 查 OpenRouter 公开接口与文档）：

- 三个模型 ID 均由接口确认存在。转写模型不在 `/api/v1/models` 里，
  要加 `?output_modalities=transcription` 才列出（该查询返回 21 个 STT 模型）。
- **AI 整理选 DeepSeek V4.1 Flash 而不是 Qwen3.8 Flash**：两者都默认开思考
  （官方元数据 `reasoning.default_enabled` 均为 true），区别在默认思考的强度——
  Qwen3.8 Flash 会投入更大比例的推理开销，DeepSeek V4.1 Flash 不会。
  维护者实测 Qwen3.8 Flash 在 OpenRouter 上整理速度较慢，据此更换。
  这与「能否调节思考档」无关：`src/llm/thinking.ts` 没有 OpenRouter 分支，
  该下拉在 OpenRouter 上本来就不可用，换模型也没有改变这一点。
- STT 端点 `/api/v1/audio/transcriptions` 同时接受 OpenAI 风格 multipart 与 JSON 正文。
  录音转写走 multipart，复用既有路径，没有新增协议分支。
- **说话人分离必须走 JSON**：分离开关经 `provider.options.<上游 slug>` 传递，是嵌套对象，
  multipart 表达不了。因此 `microsoft/mai-transcribe-2` 单独用 `openrouter-diarize` 协议
  （`src/asr/openrouter-diarize.ts`）。
- 上游 slug 由模型决定，取自 `/api/v1/models/{id}/endpoints` 的 `endpoints[].tag`。
  `mai-transcribe-2` 只有 `azure` 一个上游，文档示例也正是用 azure 演示该模型的分离。
  代码运行时查这个 slug，而不是写死 `azure`——换模型时不必改代码。
- 分离还需要 `response_format=verbose_json`，否则响应里没有 `segments[].speaker`。
  返回结构经既有 `extractTranscriptText` 归一成 `[说话人N]` 前缀，无需新解析。

### 12.2 与百炼的差异

- 百炼的导入音频走 DashScope 自有的异步任务协议（提交 + 轮询）；
  OpenRouter 是同一次请求内同步返回，因此 `transcribeWithOpenRouterDiarize` 直接返回结果，
  不产生 `taskId`。
- OpenRouter 的上游对单次请求有约 60 秒处理时限（文档明示），很长的录音建议先切分；
  百炼的整文件识别支持到 12 小时。
- 计费按音频时长与所选模型，以 OpenRouter 控制台用量页为准。

### 12.3 界面

转写服务下拉里新增 `OpenRouter · 说话人分离`（`openrouter-diarize`）。
它被判为「可做说话人分离」由协议决定（`src/asr/diarization.ts` 的
`isSpeakerDiarizationProvider`），不是 id 白名单——
用户自建的同协议服务因此也能用于导入音频。

provider 卡片的文案（标题 / 徽章 / 说明 / 步骤 / 备注 / 链接标签）在
`settings-tab.ts` 的渲染处包 `t()`；它们是数据字段，不在 `t("...")` 调用点里，
因此 `tests/i18n.test.ts` 另有一条用例专门扫这个模块。

## 13. 架构门禁：check:architecture 与基线制

`npm run check:architecture`（`scripts/check-architecture.mjs`）回答的是另一个问题：
`check:domain-boundaries` 问「这个成员、Host 能力、Service 方法是否真实存在」，
它问「**这个模块是否应该获得这项依赖？这次修改有没有扩大已有耦合？**」。
已并入 `npm run build`，紧跟在 `check:domain-boundaries` 之后——两者是同一层静态约束：
一个管引用是否合法，一个管依赖是否合法。`verify` / `verify:push` / CI 因此自动继承。

### 13.1 基线制：现有债务放行，新增债务失败

第一版不要求架构立即达到理想状态。事实基线放在**仓库内**、所有贡献者共享的
`scripts/architecture-baseline.json`（机器门禁需要仓库内、所有贡献者共享的事实来源，不能依赖任何本机文件）。
脚本只读源码与基线：不访问网络、不读构建产物、不依赖 git，本地、fork PR、CI、离线都能跑。
行为测试在 `tests/architecture-gate.test.ts`，用注入的最小源码覆盖，不扫描真实仓库。

三件事，对应基线的两个字段：

1. **禁止新的 `src/main.ts` 依赖**（`pluginConsumers` 的键集合同时充当 import 白名单）。
   除 `src/main.ts` 自身外，任何 import（含 re-export、动态 import）解析后指向 `src/main`
   都必须失败，解析走 TypeScript AST + 相对路径归一，目录层级变化不会漏掉。
   放行的 legacy 文件固定为：`src/queue/task-queue.ts`、`src/audio/recorder-service.ts`、
   `src/ui/outline-view.ts`——三者在 1.0.9 仍直接 import `main.ts`，作为债务登记在基线里。
2. **冻结三个 legacy consumer 的 `plugin.*` 能力面**（`pluginConsumers`）。
   规则是**实际使用集合与基线精确一致**，不是单纯 subset：
   新增一个 `this.plugin.imports` 直接失败；反之，若日后移除了某个能力的使用而基线没收缩，
   也失败并要求同步删除。这样债务形成单向棘轮：24 → 23 可以（改代码时同步改基线），
   23 → 24 不会无意发生——旧 allowlist 不及时收缩的话，删掉的依赖还能加回来。
3. **Service 依赖图**（`serviceEdges`）。对每个 `XxxHost` 接口，取其成员在 main.ts 里
   `this.<字段> = new <类>(...)` 对应的具体服务类，得到 `消费服务 → 依赖服务` 的有向边。
   新增边一律失败（即使尚未构成环）——A → B 单看可能无害，但可能恰好把两条路径连成环，
   要求开发者显式处理一次，比自动放行稳妥。删除边则要求同步收缩基线（同一条棘轮）。
   脚本用 Tarjan 算法求强连通分量，每次运行输出 service count / edge count /
   cyclic SCC count / largest SCC size。**第一阶段不要求 cycle = 0**：
   现有环允许存在；失败条件是不得产生新环、不得扩大既有 SCC（既有 12 个服务的大环里
   再插入一个节点，同样失败）。

### 13.2 为什么基线更新不是「修检查」的步骤

基线是**事实**（`scripts/architecture-baseline.json`），为什么这样设计写在本节（**理由**），
两者分开存放。脚本没有 `architecture:update-baseline` 之类的 npm 命令，失败信息也不提示
怎么刷新——否则最容易出现的循环是：检查失败 → 自动刷新基线 → 检查通过，门禁就此失效。
**更新基线是架构决策**：先确认新增依赖确实是该走的路（优先 callback、port、
独立 workflow service），再用 `node scripts/check-architecture.mjs --print-baseline`
打印当前事实、人工裁剪后写回 JSON，与代码改动一起提交评审。
收缩基线（删除条目）直接编辑 JSON 即可，不需要该命令。

### 13.3 第一版不查什么

文件行数上限、方法数量上限、所有 Host 禁止 `app`/`settings`、`shared/` 层级规则、
目录依赖白名单——这些方向多数属于遗留状态，第一版检查会大面积误报。
规则少，误报才少。第一版只管三件已有明确证据的问题：
`QnALogPlugin` 依赖扩散、plugin capability 面扩大、service 边/环扩大。
