# 维护说明

本文件说明 QnALog 的维护主线、许可边界、项目身份与发版流程。**改动本仓库前先读第 1、2 节。**

阅读导航：
- 新任务先看 §6；当前执行项、已完成状态、待取证事项与人工补验只以该节为准。
- 维护约束看 §1–§5；按改动再查 §8（类型）、§9–§12（设置与服务）、§13–§15（架构与笔记）。
- 产品发展方向与阶段验收看 §7；它不是已实现功能清单，也不自动改变 §6 的执行顺序。
- 已完成项与历史说明不是任务来源；历史细节从 Git、PR 与对应测试追溯。
- `AGENTS.md` 规定代理执行约束，本文件记录项目维护事实，不重复维护另一套代理流程。


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

### 1.1.1 结构边界

- `src/main.ts` 是装配根，只负责生命周期、服务组合、Obsidian 注册与少量全局持久化协调。
- 新 service 只接收显式窄能力接口或仅含所需成员的依赖对象；不得接收完整插件、完整 `App` 或完整 `PluginSettings`。
- 视图保留 DOM 创建、渲染、局部状态与交互；领域规则和工作流归 typed module、service 或 controller。
- 队列、录音器等基础组件通过 callback、port、任务处理器或事件提供能力，不反向调用高层工作流或界面。
- 纯搬迁保留调用接收者与重绘时机，不顺带改变行为；不同刷新时机不能合并成同一种回调。
- 新增域服务时同步更新 `scripts/check-plugin-onload.mjs` 的 `DOMAIN_FIELDS`。当前排期只看 §6。

#### 1.1.2 QnALog 命名空间

只写 QnALog 命名空间。品牌字面量集中在 `src/shared/namespace.ts`，读侧用 `nsRe()` 生成模式；Frontmatter 写 canonical `qnalog_*` 键，按既有读取规则兼容历史字段别名。

QnALog 不承接历史项目数据：不提供笔记迁移命令，不扫描或批量改写既有笔记。pre-1.0 的 clean break 不适用于正式用户设置；设置版本迁移政策见 §4.5。

旧 API Key 混淆 marker `qnk1:` 仅用于解码旧 `data.json`；新密钥使用 Obsidian SecretStorage。磁盘混淆不是加密。

### 1.2 第二条：按需要灵活添加提升性功能

**不要求与上游对齐，也不禁止与上游相同。**

- 确有需要时可以加新功能，包括上游也有、或与上游思路相近的功能——只要实现是我们自己写的（见 §2 的许可边界）。
- 加功能的门槛是"确实有用"，不是"上游有"也不是"上游没有"。
- 不追求功能面的完整对标；不对称是正常的，也是可以接受的。
- 这类改动同样要满足第一条的稳定性标准：新功能不能把既有链路拖坏。

提升性功能优先围绕「利用历次对话解决当前问题」：查找依据、理解变化、准备下一次讨论，而不以增加摘要、卡片或展示形式为目标。产品方向与验收见 §7；安全与数据保全仍优先，但不要求清偿全部结构债务后才开展只读的内容复用功能。

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

2026-09-13 的历史核验：当时与 `2.2.0` / `2.3.2` 的树相比，唯一内容相同的文件是 MIT 许可正文；当时 `styles.css` 与上游 tag `2.1.2` 逐字节相同。该结果不代表当前 CSS 与上游一致。`main.js` 可由本仓库源码重建（当时哈希稳定）。

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
| 更新检查 | `src/update/update-source.ts` 常量指向 `qnalog/qnalog@main` | 不得指向上游。改动后必须同步 `tests/` 中的 URL 期望值。 |
| 自更新 | **已移除** | 开发者政策 "Not allowed" 明列 *"Install or update themselves or their dependencies"*。本插件只检查版本并提示，安装交给 Obsidian 或 BRAT。**不得恢复写入自身文件的能力。** |
| 社区目录 | 上游 `lexvoice` 条目仍在 | 不可控。它只能被用户主动安装，不会替换本插件；README 已说明两者并存时的处理。 |
| 书面名称 | 界面、提示词、生成的标题、文档、仓库简介 | 面向人阅读处一律写 **`QnALog`**（含 `manifest.json` 的 `name`）。2026-09-28 起弃用旧书面名 `Q&A Log`：Obsidian 插件命名规范只允许基本拉丁字母与连字符、加号、括号，`&` 不在允许列表；macOS 原生菜单还会把 `&` 当快捷键标记吃掉。**名称里不得再出现 `&`。** 版权署名 `Q&A Log Team` 与提交身份显示名 `Q&A Log` 属于署名，不随产品名改。程序性标识仍是小写 `qnalog` 与 `QNALOG_*`（见下两行）。 |
| 内部标识符 | `QNALOG_*` 常量、`qnalog-*` CSS 类名与自定义属性 | 2026-09-14 已统一为 `qnalog`：这些字符串只存在于代码里，不写用户文件。**新代码不得再引入 `lexvoice-*` 类名或 `LEXVOICE_*` 常量。** |
| 数据层 | 标签 `qnalog/*`、默认目录 `QnALog/…`、Frontmatter 业务字段 `qnalog_*`（`qnalog_speakers` 等）、类型值 `QnALog派生版本`、视图类型 `qnalog-*-view`、旧密钥解码 marker `qnk1:` 与盐 `QnALog/local-key-obfuscation/v1` | 2026-09-15 起统一品牌命名空间；Frontmatter 业务字段另按 §1.1.2 兼容历史中文和未加前缀的英文键。插件不扫描或批量改写笔记，单篇重整/更新写 canonical 键。字段字面量集中在 `src/shared/namespace.ts`；新代码不得引入 `lexvoice-*` 字面量。`qnk1:` 与盐仅用于读取迁移前的 `data.json`，新写入的 API Key 使用 Obsidian SecretStorage。默认目录子目录名按界面语言在读取时取（`src/shared/defaults.ts` 的 `FOLDER_NAMES`），已保存路径优先。 |

发版前的隔离检查已并入本地 `npm run verify` 与 `validate.yml`。

```bash
node scripts/check-mainline-isolation.mjs
# 检查 src/、scripts/、manifest.json、esbuild.config.mjs、package.json 与构建产物 main.js：
#   1) 不出现上游仓库标识
#   2) main.js 必须包含本仓库更新源地址
#   3) manifest.json 的 id 必须是 qnalog
```

`main` 是主线与默认分支；改动在本地功能分支完成并经 PR。上游产物不得留在任何分支或 tag 上。

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
| `main` 且无未提交改动 | `x.y.z` | 发版身份，与仓库 `manifest.json` 一致 |
| 其他分支 / 有改动 | `x.y.z-dev.<分支>.<提交>[.dirty]` | 构建时注入，安装时写进知识库的 `manifest.json` |
| 游离头指针 | `x.y.z-dev.detached.<提交>` | 同上，分支位用 `detached` |

- **仓库里的 `manifest.json` 始终是发版身份，不随分支变化**——CI 会校验它与 `package.json`、
  `package-lock.json`、`versions.json` 四处一致，社区目录也只接受这一份。开发标识只出现在两处：
  构建产物内部（`QNALOG_BUILD_*` 常量）与**知识库里的那份 manifest 副本**（`npm run install:vault` 写入）。
- "有改动"只算两类：已跟踪文件有改动、或 `src/` 下有未跟踪文件。仓库里其他未跟踪草稿文件
  （`_tmp_*`、`ARCHITECTURE.md` 等）不影响打包，不会把构建标成开发版。
- 开发版标识不会触发"版本错位"告警：`UpdateService.warnIfBuildManifestSkew` 只比较 `x.y.z`。
- 查看方式：`node scripts/build-identity.mjs` 直接打印；插件设置页首页与「更新」页也会显示。

### 4.2 发版步骤

发版改动先在功能分支完成，经 PR 合并进 `main` 后再打数字 tag。推送、合并、安装与发版各自需要当前对话的明确授权；本文不构成授权。

```bash
npm version X.Y.Z --no-git-tag-version
# 更新 manifest.json；如有需要，更新 minAppVersion
node version-bump.mjs
# 编写 .github/release-notes/X.Y.Z.md，说明用户影响
npm run verify
git add -A && git commit
npm run verify:push
git push -u origin <branch>
gh pr create --base main
# CI 全绿并取得当轮合并授权后，以 merge commit 合并
git fetch origin main && git switch main && git pull --ff-only origin main
# 确认本地 HEAD 为 PR mergeCommit，manifest.version 为目标版本
npm run install:vault -- "<获授权的知识库>"
git tag X.Y.Z && git push origin X.Y.Z
```

**Release workflow 检查链**：检出 tag 的干净历史（`fetch-depth: 0`）；拒绝不在 `main` 上的 tag；`npm ci`；校验 tag 与 manifest 版本一致；运行 `npm run verify:push`；重建后逐字节比较 `main.js`、`manifest.json`、`styles.css`；要求 `.github/release-notes/<tag>.md`；上传 `main.js`、`manifest.json`、`styles.css`、`LICENSE`、`NOTICE` 五项；回读上传资产并逐字节比对。

2026-09-15 曾因 tag 先于 `main` 更新导致发布状态不一致；因此 release workflow 要求 tag commit 已在 `main`。

工作流失败时不得用本地 `gh release create` 绕过；修复 tag 源码并按流程重发。发版说明必须写明用户影响，包括设置变化、服务/密钥是否需重配、功能增删。`LICENSE` 与 `NOTICE` 随 Release 分发；四处版本一致性由 `scripts/check-version-alignment.mjs` 校验。改动设置 schema 时按 §4.5 迁移并用真实旧版 `data.json` 验证。

### 4.3 安装与回滚

- `npm run install:vault -- "<知识库>"`：安装/更新前将目标插件目录整份留档至 `<知识库>/.obsidian/qnalog-install-backups/<时间戳>/`；不得读取、移动或删除上游插件目录内容。
- `npm run restore:vault -- "<备份目录>" ["<知识库>"] [--set-enabled]`：回滚前另存当前目录，回滚本身可撤销。
- 设置结构处理见 §4.5。

### 4.3.1 分支验证、授权与安装

按序执行：分支实现 → 本地检查与提交 → 有用户可见行为变化时由维护者在 Obsidian 真机验证 → 当轮推送授权 → `npm run verify:push`、push、PR → CI → 当轮合并授权 → merge commit 并删除远端分支 → 按授权安装 `main`。

纯文档、注释或行为等价的内部搬迁只免真机验证，不免推送与合并授权。每次安装必须获授权访问当前点名的知识库；安装前确认目标并留档。安装后同一轮用 `shasum -a 256` 比对仓库与目标 `main.js`、`styles.css`，并用 `jq -r .version` 读取目标 manifest。没有授权不得访问知识库；交付说明写明未安装。

人工验证说明包括前置条件、具体入口与步骤、预期文件/界面/状态、实际结果及设备和版本。维护者确认才算通过；CI 不代替真机验证。合并后只在取得当轮安装授权时安装 `main` 上的发版构建。

### 4.4 CI 与本地检查

| 工作流 | 触发 | 权限与行为 |
|---|---|---|
| `validate.yml` | `main` push、PR、手动 `workflow_dispatch` | `contents: read`；Node 22、`npm ci`、`npm run verify:push` |
| `release.yml` | 数字 tag | `contents: write`；发布检查链见 §4.2 |

`validate.yml` 的唯一检查入口是 `package.json` 的 `verify:push`。required check 名称为 `validate`；ruleset 要求合并前更新到最新 `main`。两者防止 PR 基于旧主线合并或因 job 名变化而无法满足保护规则。裸推功能分支不会触发 CI。

`verify:push` 在 `verify` 基础上执行 `check:bundle-consistency`：从已提交 HEAD 重建并与 HEAD 的 `main.js` 比较。`git status --porcelain main.js` 只能发现已重建但未提交，不能发现根本未重建；bundle 检查要求源码先提交。

`npm run build` 运行下表中 build 项；`npm run verify` 另运行 legacy-prefix、settings-map、lint 与测试。装配与合并冒烟脚本分别在构建路径执行一次，不将聚合命令误算为额外重复运行。

| 命令 | 阶段 | 检查内容 |
|---|---|---|
| `npm run check:versions` | build | 四处版本一致 |
| `npm run check:undefined-symbols` | build | `@ts-nocheck` 文件未定义引用 |
| `npm run check:domain-boundaries` | build | 插件成员与 Host/service 能力真实存在 |
| `npm run check:architecture` | build | 架构基线的依赖边界，见 §13 |
| `npm run check:plugin-onload` | build | 域服务装配与模拟宿主加载 |
| `npm run check:merge-pipeline` | build | 模拟宿主中真实 bundle 的会话收尾到写笔记路径 |
| `npm run typecheck:core`、`tsc -noEmit` | build | strict-core 与常规 TypeScript 诊断 |
| `npm run check:legacy-prefixes` | verify | 禁止旧项目品牌前缀回到源码/样式 |
| `npm run check:settings-map` | verify | §9.1 键集合与落盘路径一致 |
| `npm run lint`、`npm test` | verify | ESLint 与 Vitest |

检查器的分工：legacy-prefix 拦截品牌漏改；plugin-onload 拦截服务漏装；merge-pipeline 运行收尾到笔记写入链；domain-boundaries 校验成员归属。构建对装配检查与 merge-pipeline 各执行一次。


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

本次 1 → 2 迁移新增 `security.apiKeyStorageNamespace`，用于区分不同知识库的 SecretStorage 条目。`loadAll` 先恢复或导入 API Key；只有 SecretStorage 写入成功后，`saveAll` 才清空设置快照中的密钥字段。Obsidian SecretStorage 没有删除方法，清除密钥时写入空值；设置版本高于当前版本时不改动 SecretStorage，也不写 `data.json`。

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

## 6. 当前任务与状态

本节是当前执行项、待取证事项和人工验收边界的唯一入口。历史细节从 Git、测试与 PR 追溯；完成记录不构成新任务。

### 6.1 当前推进

- **P2.3：关键持久化域的类型与能力闭合**。范围：录音/续录终止、队列恢复、笔记写入、版本保全。`TaskQueue` 与 `VersionStore` 已使用窄宿主能力；LLM 失败分类已迁入严格检查的纯策略模块。
- 2026-10-04 将 `src/queue/task-queue.ts` 纳入 strict-core；队列公开方法、任务生命周期和重试流程的临时严格诊断与常规 TypeScript 诊断均为 0。`load(saved: unknown)` 的恢复边界已在本地分支 `fix/queue-recovery-boundary` 实现：合法三类任务经字段校验后恢复；其它原行暂停并按原顺序保留，相关会话依赖和音频引用继续受保护。模拟宿主与自动化覆盖已完成，真实 Obsidian 验收尚未进行。`RecorderService` 已改用七项录音宿主能力，纳入 strict-core；自动化覆盖停止事件、超时、最终回调、母带回退、切段重启失败、暂停恢复、动态设备设置与 MIME 选择。录音切片交付流程现位于严格检查的 `src/audio/recording-segment-flow.ts`；普通切片返回前等待切片与母带落盘，最终切片等待串行处理和会话收尾。`tests/recording-segment-flow.test.ts` 覆盖等待时点、处理顺序、失败材料、任务状态、收尾拒绝和动态短录音设置；`tests/short-recording-flow.test.ts` 补充 masterOnly 消费者验证。真实麦克风、Obsidian 和移动端未验证。`RecordingService` 启停、续录收尾控制流、笔记写入和版本保全仍未完成；不得把 `QueueRetryService` / `NoteWriter` 间接 host 能力写成已收窄。
- 2026-10-06 将版本清单读取校验、按来源串行化、逐级建目录、写入与逐字节回读确认迁入 `src/versions/version-manifest-store.ts` 并纳入 strict-core；共享 YAML frontmatter 对象解析及原稿快照查找、身份校验、同来源单飞、保存后路径确认迁入 `src/versions/version-content.ts` 与 `src/versions/original-snapshot-store.ts` 并纳入 strict-core；本批再将版本缓存创建、保存清单登记与最终确认迁入 `src/versions/version-save-store.ts` 并纳入 strict-core。`VersionStore` 保留公开保存和原稿入口，通过执行时读取的窄回调访问宿主能力；派生笔记与版本切换仍由 `VersionStore` 处理。`tests/version-manifest-store.test.ts` 与 `tests/clean-transcript-storage.test.ts` 覆盖清单校验、失败释放、未知字段保留、动态 adapter、同来源串行与跨来源并行、缓存竞争与回读错误、最终清单确认失败、分段元数据、快照身份拒绝、pre-clean 复用及保存后路径确认；模拟保存/切换冒烟已运行，未进行真实 Obsidian 验证。续录收尾、笔记写入及 `RecordingService` 启停仍未完成。
- **P3：A8 沉淀交互控制器**。后续任务需整体定义并验收扫描、取消、自动推进、提交、撤销和 DOM 边界；不重新拆整个 `OutlineView`。真实视觉与交互由维护者确认。
- 真实用户数据损坏或安全问题优先。尚未定位的截图或 `partial` 状态不作为已定位故障。

### 6.2 待取证、待维护者决定与暂停项

- **机器数据展示**与**历史 `partial` 原因**是条件调查，按 §6.4 的授权与取证边界执行。`invalid-json` 不证明磁盘 JSON 损坏；不删除状态标记、不伪造 `complete`，不访问未授权知识库。
- **A12 产品决定**：索引写入和两种笔记布局的代价见 §14.4；由维护者决定。§7 提供索引的候选读取用途，不据此提前改动存储或布局。
- 服务推荐需在具体需求出现时重新核实能力、地区与费用；历史流式任务恢复仅在实际恢复需求出现时调查。
- `modals.ts` 按域拆包、更新检查薄转发、专属服务展示、整体 `OutlineView` 拆分均暂停或可选，不排入当前执行队列。
- 剩余正则漏检或 CSS 输出问题只在审计证据或真实输出问题出现时启动。三个 `@ts-nocheck` 文件的处理条件见 §8。
- **内容复用候选，尚未进入实施**：下一项提升性功能优先考虑「对用户选定的多篇纪要进行带来源的问答与专题回顾」（§7.3 第一阶段）。启动时在 §6.1 登记具体范围和验收，不自动替换 P2.3/P3；后续阶段须根据使用效果决定，不作为代理自动执行清单。

### 6.3 已完成与验收范围

| 事项 | 已完成结果与证据入口 | 人工确认范围 |
|---|---|---|
| 设置迁移与恢复工具 | 正式用户四态迁移见 §4.5；恢复脚本路径边界由 CLI 测试及临时目录冒烟覆盖 | 未进行真实 Obsidian 验证 |
| 短续录丢弃 | 失败时保留可恢复任务，重试只清理暂存；`tests/short-recording-flow.test.ts` 覆盖队列重载与失败恢复 | fresh 库确认 2 秒丢弃、4/8 秒追加 |
| 初稿/派生稿及重新整理文案 | 有效快照时显示本地化 Original/初稿；任务状态和通知使用界面模式名称；见 `tests/outline-recent-variants.test.ts`、`tests/recent-note-variants.test.ts`、`tests/clean-transcript-storage.test.ts` | 英文新写入、列表观察仍待 §6.4 |
| 负向装配隔离 | 独立临时 bundle 检查漏装，不改写共享源码；见 `tests/plugin-onload.test.ts` | 不适用 |
| 笔记正文保全 | 实时转写按结束标记长度清理；转写内容按字面量插入；见 `tests/live-asr-pipeline-service.test.ts`、`tests/transcript-queue-retry.test.ts` | 未进行真实 Obsidian 验证 |
| A6 结构归属 | `note-document.ts` 提供位置/范围操作；协议语义留在各领域模块；消费者矩阵见 §14.4 | 2026-10-01 维护者确认 `note-document-readers` 本批无特定问题，不代表 A6 全部变更均已验收 |
| A10 非 UI 辅助归属 | 音频输入纯函数在 `audio/audio-input.ts`，前言剥离在 `note-document.ts` | 设备枚举与权限仍由宿主/UI 处理 |
| 会话状态与实时转写 | PR #83 完成抽取；维护者确认整理期间续录成功 | 其它场景仅按 §6.4 条件补验 |
| Q 图标 | PR #85 完成图标更新 | 桌面辨识已确认；移动端见 §6.4 |
| 首次配置与说话人设置 | 向导、快捷配置、侧栏入口已实现；API 页含说话人配置，见 §10–§12 | 未记录的新写入场景不宣称已人工确认 |
| 持久化域能力与失败分类 | `TaskQueue` / `VersionStore` 窄能力及纯失败策略已完成；`RecorderService` 使用七项窄宿主能力并纳入 strict-core，见 `tests/recorder-service.test.ts`；`recording-segment-flow.ts` 纳入 strict-core，分段缓存/母带保存时点、串行处理、失败保留及收尾等待见 `tests/recording-segment-flow.test.ts` 和 `tests/short-recording-flow.test.ts`；`util-audio.ts`、`util-key-diag.ts`、`task-queue.ts` 与 `queue-recovery.ts` 也已纳入 strict-core。队列恢复解析、原行保留、依赖/音频引用保护及暂停条目界面见 `tests/queue-recovery.test.ts`、`tests/continuation-queue.test.ts`、`tests/live-asr-pipeline-service.test.ts`、`tests/progress-modal-contract.test.ts` | 队列恢复等待维护者在测试库副本中进行真实 Obsidian 验收；切片交付未进行真实麦克风、Obsidian 或移动端验证 |

### 6.4 人工补验清单

以下是相关改动或取证获得授权时的条件清单，不要求现在全部执行，也不阻塞无关离线改动。维护者确认才算真实宿主验收；自动模拟不代验。

1. **初稿/派生稿与英文新写入**：在本轮获授权的测试库副本中选择有有效原稿快照的纪要，分别用中文和英文重新整理为同类型、不同类型。检查新版本卡标签、任务/通知/完成日志是否使用界面类型名称；展开侧栏母本的 variants，分别点击 Original/初稿和派生稿，确认显示对应版本。普通重新整理只生成派生稿，不要求自动激活、母本重命名或派生稿独立顶层条目。缺快照时不得显示假初稿链接；不得覆盖用户自定义类型名，也不批量翻译旧原始材料。曾报告列表未找到输出，只待界面观察，不代表文件丢失或列表故障已定位。
2. **机器数据展示**：在包含会话知识、索引和活动版本标记的同一授权副本中，分别打开源码、实时预览和阅读视图，记录模式与截图。源码显示存储标记是预期；分别记录其他模式中长注释和索引折叠标题是否占正文，不预设已隐藏。对照切换版本前后的正文与结构读取结果，确认机器数据可读且活动范围未删除；此项只调查展示，不修复笔记。
3. **历史 `partial` 原因**：取得单独日志/服务授权后，核对同场转写来源、诊断与模型原始回复，区分非合法 JSON、响应结构不符和后续保存异常。保留 `partial` 与 `issues` 原文，只记录证据能证明的原因。找不到历史响应时记“原因未核实”；不改为 `complete`，不擅自重跑原笔记或请求在线服务。
4. **会话/正文路径**：仅在相关改动需要真实验证时使用授权测试副本。普通录音超过 10 秒后暂停、恢复、停止，确认音频可播放且转写与成稿来源一致；普通录音分别低于 3 秒及 3–10 秒，确认丢弃与仅保留音频规则；音频与文字导入，确认原材料和整理来源；中断服务后恢复并手动重试，确认失败任务与材料保留且不重复追加；异步准备续录期间切换活动笔记，确认只写原定目标或阻止操作。未逐项记录的宿主覆盖只标“未记录”，不宣称从未测试。正文修复补验需固定返回文本的测试转写服务：在实时转写结束标记后放置多行 Unicode 正文，令服务返回含 `$&`、美元符号紧接反引号、`$'`、`$$` 的文本，结束录音后检查全文，确认标记后正文未截断且字符串按字面量保存。没有该服务条件时，只记录自动消费者测试覆盖，不宣称真机验收。已确认的 2/4/8 秒续录及整理中续录不列为未验证。
5. **移动端 Q 图标**：维护者有手机和授权测试库时重载插件，打开实际工具栏/侧栏入口，确认 Q 可辨识、未裁切且点击打开正确视图；记录系统、Obsidian/插件版本与截图。桌面辨识已确认，不要求重复验证。

## 7. 产品方向、阶段验收与功能边界

### 7.1 方向与现有基础

**发展目标：从整理一次对话，扩展到利用历次对话查找依据、理解变化，并准备下一次讨论。** 录音、可靠转写与原始材料保全仍是基础；内容复用以用户要解决的问题为单位，不以合并整个目录或生成更多文件为目标。

以下为 2026-10-04 核对的现有基础，不代表跨纪要能力已经实现：

| 基础 | 已有能力与证据入口 | 规划需要补足的部分 |
|---|---|---|
| 单篇问答 | 当前纪要与原始转写构成上下文，原文优先；`src/notes/ask-panel.ts:33–47` | 多篇资料选择、跨纪要查找与综合 |
| 会话知识与来源 | 议题、决定、行动、问题及证据引用，含 `complete/partial/unavailable/stale` 状态；`src/briefing/session-knowledge.ts:8–34`；转写来源与修订见 `src/transcript/session-transcript.ts:16–57` | 跨文件来源去重、引用定位与变化后的有效性判断 |
| 笔记索引 | 单篇摘要、主题及知识状态；决定、行动和问题在索引中只是 ID 列表，不是完整证据；`src/indexing/note-index.ts:26–67` | 索引的检索消费者及回到正文、转写的读取路径；存储取舍见 §14.4 |
| 对象复用 | 人员关联、待办汇总和热词用于后续识别；`README.zh-CN.md:71–83` | 在后续讨论中使用历史资料，不另建人员库或待办状态副本 |

### 7.2 用户任务与判断边界

- **查证与综合**：查证回答「哪次讨论提到什么」，优先返回来源原文；综合回答「几次讨论为什么得出某个结论」，须列出依据、分歧和证据不足之处。两者都显示实际资料范围，不暗示已查遍知识库。
- **持续主题回顾**：用户保存一个可调整的资料范围，查看有依据的结论、变化、未解决问题与相关行动。主题首先是资料范围和回顾视图，不要求先建立复杂分类或项目管理系统。后来的说法不自动替代早先决定；区分补充、适用条件不同、分歧、明确替代和模型推断。
- **准备下一次讨论**：会前整理已确认事项、进展与待追问问题；会中由用户主动查询历史；会后提出与历史相比的变化候选。历史材料不混入本次原始转写，更新主题、人员或待办须经确认。
- **可选主动提示**：在前述能力得到验证后，再评估反复未解的问题、不同说法及后续事项提示。「未找到完成记录」不等于「没有完成」；不自动勾选任务、认定责任人、合并同名人物或执行外部行动。

### 7.3 分阶段交付与验收

本表记录发展顺序，不承诺版本或日期，也不是新增的执行队列。每阶段以实际使用效果决定是否继续；当前候选与实施状态只在 §6 维护。

| 阶段 | 可交付的用户能力 | 进入下一阶段前的验收重点 |
|---|---|---|
| 1. 选定多篇问答 | 用户选择多篇纪要，查证或生成专题回顾 | 关键结论有可打开且支持结论的来源；列出分歧与证据不足；派生稿不重复计为独立证据；不改源文件 |
| 2. 范围内自动检索 | 在用户允许的资料范围内自动找相关记录 | 中文、别名及不同表述的查找效果；编辑、重命名、删除及版本切换后结果正确；展示检索范围与未覆盖材料 |
| 3. 持续主题回顾 | 保存资料范围，刷新结论、变化和未解决问题 | 区分补充、分歧、替代与推断；引用保持有效；刷新不覆盖人工内容 |
| 4. 下次讨论准备 | 生成会前材料，支持主动历史查询及会后变化比较 | 减少人工翻找与重复讨论；历史内容不混入本次转写；确认后才更新对象 |
| 5. 可选主动提示 | 提示值得核对的变化、问题和后续事项 | 来源明确、可关闭、可忽略；维护者评估误报可接受后才扩大范围 |

**首项验收场景**：选中几篇关于同一问题的纪要，询问「最后为什么选择方案 B」。结果按时间列出相关讨论、决定依据和仍存在的分歧，每项可回到来源；不足以判断最终决定时明确说明。该操作不创建任务、不更新人员资料、不改写原纪要。超过可处理范围、材料缺失、请求失败或取消时，明确报告未完成范围，不把部分结果描述为完整回顾。

每批开发应包含一个完整的用户场景：入口、读取范围、结果、失败边界和验证。不先分别建设索引、向量或关系框架，再寻找使用用途。第一阶段通过显式选材验证多来源回答；自动检索在第二阶段单独验收，避免把漏检与回答错误混为一项。

### 7.4 数据、实现与隐私边界

**资料范围不等于目录前缀。** `QnALog/` 是可配置的默认路径，里面同时包含纪要、录音、对象、报告、归档及运行数据（`README.zh-CN.md:113–130`）。新增功能应遵守以下边界；这些是未来实现要求，不是当前能力声明：

1. **明确选材**：依据材料为原始转写及用户明确选入的资料；纪要、人工补充和已确认对象须标明其来源性质。缓存、诊断日志和队列不参与内容检索；不因为位于同一目录就上传或处理。现有不自动扫描、迁移或批量改写笔记的约束不变；未来范围检索须由用户明确启用并限定读取范围。
2. **来源去重**：同一录音的纪要、清稿、重整版本和报告不构成多份独立证据。历史 AI 回答不得反过来证明自身；综合结果须追溯原始来源。文件路径或内容哈希不能单独承担跨文件来源身份，复用已有来源与版本关系，不另造相互冲突的身份体系。
3. **读取职责**：先确定允许范围，再查找候选笔记，读取相关正文与转写证据，最后生成回答。转写模块保留来源与修订所有权，会话知识模块保留证据校验与状态；跨笔记查找、去重和回答各有明确职责，界面只展示范围、来源和确认操作。不把工作流加入 `main.ts`、`OutlineView` 或底层索引模块；依赖按 §1.1.1、§13 审查。
4. **检索选择**：优先评估标题、主题、正文、人员、时间及关键词检索，覆盖中文与别名；只有代表性问题的漏检证明需要时，再增加按语义相似度查找文本的向量检索。现有索引是候选读取基础，不是完整知识数据库，也不因此预先决定其持久化位置。
5. **保全与降级**：检索缓存须能从来源文件重建，删除缓存不丢失用户知识。来源修改、删除、重命名或切换版本后重新判断引用有效性；旧笔记缺少结构化知识时可按正文查找并说明引用精度，不强制批量重整，不伪造完整状态。待办完成态仍以现有 Markdown 任务状态为准。
6. **授权与服务**：本地检索范围和发送给模型的内容分别说明并授权；展示本次来源、模型服务及材料规模，提供取消入口。资料保存在本地不等于模型处理在本地，云端处理和费用须明确。可选订阅不是内容复用的前置条件。
7. **只读默认**：回答不改源笔记；保存结果或更新对象须显式操作。笔记中的命令或提示词只是资料，不授予工具权限。新功能上线时同步更新 README 与隐私说明；本文不授权访问任何真实知识库或在线服务。

### 7.5 价值验证与暂不优先的方向

用经授权的代表性资料与人工问题集评估：找到可核对答案的时间、引用是否支持结论、必要来源是否遗漏、回顾是否被再次使用、会前翻找是否减少，以及等待时间、费用和纠正成本。问题集应包含无答案、不同说法、派生重复、来源变化与旧笔记缺结构的情况。记录实际结果，不按生成文件数或提取条数验收，不为评估新增遥测。

自动消费者测试验证来源、状态与文件保全；真实模型评估回答质量，真实 Obsidian 验证来源跳转与交互，三者不互相替代。未取得数据或服务授权时，不用合成材料的通过结果宣称真实使用价值。

暂不优先建设全库自动知识图谱、批量卡片/摘要/周报、通用聊天助手、完整任务或客户管理系统、自主修改知识库的 Agent。只有明确的使用任务和读回路径证明必要时再评估，不因展示形式或技术流行而加入。

### 7.6 已裁剪场景与保全规则

招聘、晋升及学习卡片入口已移除；学习笔记模式仍保留。裁剪不授权删除、扫描或批量改写用户已有文件。未知历史模式必须安全降级；重新增加场景时需提供完整的提示词、设置登记与测试。设置版本和命名空间规则分别见 §4.5、§3。

新增内容提取必须同时定义后续使用入口；没有读回用途，不以生成更多对象作为复用能力的完成依据。

## 8. 类型检查边界

- 三个仍带 `@ts-nocheck` 的文件为 `asr/clients.ts`、`ui/modals.ts`、`ui/settings-tab.ts`。暂停退出；只在结构性改动需要或出现只有类型检查才能拦截的回归时单独重启。
- 常规 `tsc` 检查当前配置范围；`check:undefined-symbols` 检查 `@ts-nocheck` 文件中的未定义引用；`typecheck:core` 使用更严格的 `tsconfig.strict-core.json`。三者覆盖范围不同，不互相替代。
- 如需估算某个 `@ts-nocheck` 文件的退出成本，可用 TypeScript `CompilerHost` 在内存中移除指令并读取语法、语义诊断；过滤 TS2304 只用于区分已有 undefined-symbols 门禁，不得掩盖真实错误。
- 常见修法：跨模块读取的 class state 显式声明字段；用联合类型收窄表达变体差异；修正错误缺失的联合成员或参数可选性。先核对调用点，不能为消除诊断改变真实行为。
- 新文件不得使用 `@ts-nocheck`；`@ts-nocheck` 退出、常规类型检查与 strict-core 覆盖是三个不同目标。
## 9. 设置映射表

本节包含 `PluginSettings` 全部 86 个顶层键与 `SETTINGS_SCHEMA_VERSION = 2` 的当前映射。

`scripts/check-settings-map.mjs` 只校验键集合与落盘路径。表格“拟归属”列是原分层设计注记，不是未批准的页面迁移任务。新增设置键必须同步登记 `normalizePluginSettings` 与 `serializePluginSettings` 白名单，否则读写会丢失该键。

列含义：默认值取自 `src/shared/defaults.ts`；落盘位置与别名取自 `src/shared/settings-io.ts`；现入口记录当前可修改界面；`拟归属`仅供查询。

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
| `apiKeyStorageNamespace` | `""` | `security.apiKeyStorageNamespace` | — | 区分不同知识库的 SecretStorage 条目 | 无 | 内部（保留存储，不进设置界面） |
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
| `setupWizardDismissed` | `false` | `setupWizardDismissed` | — | 关闭过首次配置向导后不再自动弹出；首页的向导按钮不受它控制 | 无 | 基本设置 |
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
| `lastUpdateCheckAt` | `null` | `updates.lastCheckedAt` | — | 上次检查更新时间 | 关于（只读展示） | 内部（保留存储，不进设置界面） |
| `availableUpdate` | `null` | `updates.available` | — | 已发现的可用更新 | 关于（只读展示） | 内部（保留存储，不进设置界面） |
| `lastUpdateError` | `""` | `updates.lastError` | — | 上次检查失败原因 | 关于（只读展示） | 内部（保留存储，不进设置界面） |
| `installedUpdateVersion` | `""` | `updates.installedVersion` | — | 当前已安装版本记录 | 内部（程序写入） | 内部（保留存储，不进设置界面） |

### 9.2 当前设置页

当前设置页由首页和六个功能页组成：录音、API、AI 整理、资料库、自动导入、关于。API 页包含说话人配置；快捷配置、首次配置向导与侧栏入口是三项不同操作。具体入口以 `src/ui/settings-tab.ts` 为准。

### 9.3 设置材料维护

以当前代码为准修正事实，不建立与实现平行的第二套规则。完成项和历史冲突记录不构成待办；新问题需由 §6 收录。

### 9.4 服务推荐

服务推荐需在有具体需求时核实模型能力、地区和费用，不从代码默认值推导推荐结论；任务入口见 §6。

### 9.5 设置改动约束

1. 一次只解决一个明确问题；不把设置页改造与录音流程重构捆绑。
2. 设置只有一套实际存储；不同界面读写同一组字段，不新增同步副本。
3. 预设只写服务配置所需字段，不覆盖目录、提示词、设备或自动化偏好。
4. 配置修改、转换与检测各有单一实现；检测候选配置，不写盘。
5. 不引入通用表单框架、预设市场或新依赖。
6. 新业务逻辑放有类型检查的模块，不以退出 `settings-tab.ts` 的 `@ts-nocheck` 为前置条件（见 §8）。
7. 测试覆盖用户后果：无效密钥、部分服务失败、取消、重启读回及已有配置保留。设置 schema 改动遵守 §4.5。

---
## 10. 首次配置：预设范围、检测与四态

任务 1 的产物。对应的实现在 `src/setup/index.ts`（有类型检查），行为测试在 `tests/setup.test.ts`。

### 10.1 预设改哪些字段

预设**只写完成服务配置所需的键**，清单集中在 `PRESET_WRITTEN_FIELDS`：

| 写入 | 键 |
|---|---|
| 是 | `transcribeProviders`、`activeTranscribeProvider`、`importTranscribeProvider`、`importSpeakerDiarization`、`llmServicePreset`、`llmEndpoint`、`llmModel`、`llmApiKey`、`llmProfiles`、`activeLlmProfile` |
| 否 | 其余 76 个键，含目录、提示词、录音设备、分段与并发、重试、诊断、自动导入 |

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


---

## 11. 首次配置服务事实

本节记录服务协议，不规定唯一首次配置路径。快捷配置的服务选项见本节与 §12；实际 UI 入口以代码为准。

### 11.1 百炼当前预设

| 用途 | 服务（provider id） | 模型 | 接入方式 |
|---|---|---|---|
| 录音转写（分段） | `dashscope-chat` | `qwen3-asr-flash` | HTTP（OpenAI 兼容）`/compatible-mode/v1/chat/completions` |
| 导入音频（整文件） | `dashscope-filetrans` | `qwen-audio-3.0-asr-flash-filetrans` | DashScope 异步 `/api/v1/services/audio/asr/transcription` |
| AI 整理 | 服务预设 `dashscope` | `qwen3.8-flash` | OpenAI 兼容 `/compatible-mode/v1` |

此预设共用一把密钥，写入字段受 §10.1 的 `PRESET_WRITTEN_FIELDS` 约束。录音转写使用 HTTP，桌面和移动端共用路径；浏览器 WebSocket 不能设置鉴权请求头，因此实时流式只供可用桌面环境手动选择。实现按 3 分钟切块预算处理，服务请求上限以供应商文档为准。整文件识别使用异步提交与轮询。

### 11.2 协议参数

`disfluency_removal_enabled` 只对 Paraformer 下发；`language_hints` 仅在用户指定语种时发送，否则省略。参数构造位于 `src/asr/realtime-params.ts`，由 `tests/realtime-params.test.ts` 覆盖。

### 11.3 快捷配置与入口

首页提供“快速配置”“首次配置向导”“打开侧边栏”三个动作。快捷配置有服务供应商下拉与内置地址、模型；只有候选配置的检测全部通过才保存，“仅检测”不写盘。向导是独立流程，不等同快捷配置。当前供应商、默认项与表单字段以 `src/ui/settings-tab.ts` 和 `src/llm/config.ts` 为准；预设不覆盖用户目录、提示词或设备选择。

### 11.4 平台与请求限制

HTTP 分段转写支持桌面与移动端；实时 WebSocket 受浏览器鉴权头限制，仅在可用桌面环境手动选择。HTTP 请求超过服务单次限制时按实现切块；非实时整文件识别按服务协议异步执行。服务限制和费用以供应商当前文档为准。

### 11.5 已修复的协议检测问题

历史检测曾把 `wss://` 地址交给 HTTP 上传，误报协议不受支持；真实流式检测现执行 WebSocket 握手，HTTP 服务仍使用上传检测。endpoint 按协议校验，未放宽明文传输与内网限制。回归覆盖见 `tests/endpoint-transport.test.ts`、`tests/bailian-setup.test.ts`。

### 11.6 流式服务与历史分段任务

已录制的 HTTP 分段不能交给实时流式服务处理。`describeSegmentRetryUnavailable`（`src/queue/queue-retry-service.ts`）在可确认当前服务为流式协议时给出可执行说明；无法读取服务档案时不拒绝重试。`tests/segment-retry-guard.test.ts` 覆盖该边界。新录音走流式服务时不生成分段任务。历史流式任务是否恢复只在实际需求出现时调查，见 §6。

### 11.6.1 音频设备识别与选择

`classifyAudioInputDevices`、`pickComputerAudioDevices` 等纯函数位于 `src/audio/audio-input.ts`；设备枚举、授权申请和设置交互仍由 UI/宿主能力负责。

- 麦克风列表保留全部输入设备并分类；电脑音频优先列出识别出的虚拟输入，无可识别项时列出非系统默认输入。
- 分类只供参考，不自动选择设备。缺少设备名称与没有输入设备是不同状态。
- `enumerateDevices()` 不申请权限；只有用户主动打开设备选择或触发检测时才请求名称权限。

### 11.7 首页使用状态

首页只按核心配置是否缺失判断能否开始使用；警告不算 blocker。状态行按语音转写、AI 整理、说话人识别、音频输入显示，并跳转到对应 API 或录音设置页。状态数据来自有类型检查的 `buildSetupStatus`（`src/setup/index.ts`）；测试结果的四态定义见 §10.3。

---

## 12. 首次配置：OpenRouter 一站式方案

OpenRouter 是快捷配置可选预设之一，面向能够访问其服务的用户；快捷配置默认值和其他选项见 §11.3。服务配置仍由 §10.1 的字段白名单约束。

### 12.1 内置的三段服务与模型

| 用途 | 服务（provider id） | 模型 | 接入方式 |
|---|---|---|---|
| 录音转写（分段） | `openrouter` | `qwen/qwen3-asr-1.7b` | OpenAI 兼容 `/api/v1/audio/transcriptions`（multipart） |
| 导入音频（整文件，带说话人分离） | `openrouter-diarize` | `microsoft/mai-transcribe-2` | 同一端点，JSON 正文 + `provider.options` |
| AI 整理 | 服务预设 `openrouter` | `deepseek/deepseek-v4.1-flash` | OpenAI 兼容 `/api/v1` |

三段共用同一把密钥，写入范围仍受 §10.1 的 `PRESET_WRITTEN_FIELDS` 约束。

**协议边界**：录音转写使用 multipart；导入音频的说话人分离通过 JSON 发送嵌套 `provider.options`，响应使用 `verbose_json` 并读取 `segments[].speaker`。上游 slug 按模型端点运行时查询；协议适配位于 `src/asr/openrouter-diarize.ts`，能力判断按协议而非固定 provider id（`src/asr/diarization.ts`）。

### 12.2 与百炼的差异

导入音频在此路径中同步返回；百炼使用异步提交与轮询，具体协议见 §11.1。时限、费用和模型限制以服务方当前文档为准。维护者曾反馈所选 OpenRouter 整理模型速度较慢，该观察只是当时模型选择的原因，不是持续性能断言。

### 12.3 界面

转写服务下拉提供 `OpenRouter · 说话人分离`。provider 卡片文案在 UI 渲染处翻译；`tests/i18n.test.ts` 覆盖数据字段文案。

## 13. 架构门禁：check:architecture 与基线制

`npm run check:architecture` 与 `check:domain-boundaries` 一起检查依赖方向：前者判断依赖是否扩大，后者判断引用能力是否真实存在。该门禁并入 `npm run build`，因此 `verify`、`verify:push` 与 CI 自动执行。

### 13.1 基线规则

`scripts/architecture-baseline.json` 记录所有贡献者共享的现有依赖事实；测试见 `tests/architecture-gate.test.ts`。门禁核对五类依赖：

1. `pluginConsumers`：禁止新增 `src/main.ts` import；冻结遗留消费者对完整插件对象的 `plugin.*` 使用集合。
2. `serviceEdges`：按 Host 接口和装配服务识别依赖边；新增边、新环或扩大既有环失败。
3. `uiImportsFromNonUi`：冻结非 UI 模块对 `src/ui/` 的直接依赖。
4. `hostCapabilities`：冻结 Host 接口对完整 `PluginSettings` 或完整 `obsidian.App` 的直接属性。
5. 基线字段变更须与代码一起人工审查，已有债务可保持或收缩，不得无审查扩大。

当前 `pluginConsumers` 仅有 `src/ui/outline-view.ts` 一个 legacy consumer。服务依赖图是静态检查，不是完整运行时依赖审计。Host 检查不穿透类型别名、继承、重新导出或结构等价类型。

### 13.2 基线更新

基线是仓库事实，不自动刷新。新增依赖前先确认依赖方向，优先 callback、port 或独立 workflow service；再用 `node scripts/check-architecture.mjs --print-baseline` 生成数据，人工审查后与代码改动一起提交。删除依赖时同步收缩基线。

### 13.3 检查范围

门禁检查 `src/main.ts` 依赖、legacy 插件能力面、服务依赖边/环、非 UI 到 UI 的依赖、Host 完整宽能力；不检查文件行数、方法数量、`shared/` 层级或全运行时依赖关系。

## 14. 架构事项索引与保留设计

### 14.1 索引说明

本节是技术索引，不是执行队列；当前唯一任务入口是 §6。

### 14.2 A1–A13 索引

| 编号 | 主题 | 当前事实 / 条件 |
|---|---|---|
| A1 | Host 构造类型 | 已完成；服务构造时检查 Host 契约。 |
| A2 | Host 宽能力 | 门禁完成；存量收窄未完成，纳入 §6 的 P2.3。 |
| A3 | 录音会话状态 | PR #83 已完成；人工场景按 §6.4 条件补验。 |
| A4 | 服务运行时依赖环 | PR #83 已处理；静态门禁见 §13。 |
| A5 | 基础组件反向依赖界面 | 已移除队列直接刷新界面的调用。 |
| A6 | 笔记结构操作归属 | 通用位置/范围操作在 `note-document.ts`；协议矩阵见 §14.4。 |
| A7 | 严格类型覆盖 | strict-core 继续扩展；具体推进只见 §6。 |
| A8 | 沉淀工作流与 DOM | 控制器范围见 §6；不启动整体 `OutlineView` 拆分。 |
| A9 | 目录归属 | 既有搬迁已完成；不启动全仓命名搬迁。 |
| A10 | 非 UI 依赖 UI 辅助 | 五个纯函数依赖已迁移；设备交互仍由 UI/宿主负责。 |
| A11 | 门禁正则识别 | 仅在证据表明存在漏检时启动。 |
| A12 | 索引与笔记布局 | 待维护者决定，见 §14.4。 |
| A13 | CSS 类名与产物大小 | 不因未引用数量启动清理；出现真实输出问题时再查。 |

### 14.3 保留设计

- `src/main.ts` 保持装配根，架构门禁继续用基线阻止新增依赖。
- 纪要分部断点先写 `.tmp` 再改名。
- `saveAll` 保持串行尾链。
- `scripts/check-merge-pipeline.mjs` 用桩模型运行真实 bundle 验证会话收尾到笔记写入。
- `src/notes/outline-text.ts` 保持纯函数，不依赖 Obsidian、DOM 或文件读写。
- OutlineView 的 `scheduleUpdate()` 与 `render()` 重绘时机不同，不合并。
- i18n 继续以英文原文为键；英文 locale 文件为空是有意设计。
- ASR、LLM、队列三层重试分别处理服务不可用、模型请求与任务恢复，不合并。

排除项：`settings-io.ts` 读取 `update-source` 是有意依赖；构建中的 `check:plugin-onload` 与直接执行 `check-merge-pipeline` 各跑一次，不是重复。
### 14.4 结构归属与产品待决

**A6 消费者矩阵**

| 结构 | 归属与边界 | 消费者与现有验证 |
|---|---|---|
| 外层前言、活动版本、details/heading、会话范围、字面标记偏移、原始材料插入位置 | `notes/note-document.ts` 只返回结构范围/位置；调用者决定追加、替换、错误和写盘策略 | `note-markdown.ts`、`note-writer.ts`、`queue-retry-service.ts`、`meeting-workbench-service.ts`、`version-content.ts`；对应消费者测试覆盖 |
| 带来源 ID、修订记录和可见正文配对的逐字稿账本 | `transcript/transcript-markdown.ts` 保留 source/revision/evidence 验证、正文/JSON 顺序、损坏拒写与尾部恢复；不替换为通用配对扫描 | `session-transcript`、`asr-transcript-result`、`continuation-commit`、`transcript-queue-retry` |
| 会话知识 HTML 注释及证据状态 | `briefing/session-knowledge.ts` 保留 JSON schema、证据校验、`partial`/`stale` 状态和 malformed 处理 | `session-knowledge`、`text-correction`、`note-index` |
| 笔记索引与沉淀机器壳 | `indexing/note-index.ts` 与 `sediment/` 分别拥有各自 JSON/容器格式；仅共用通用 details 范围，不搬 schema | `note-index`、`machine-block-fold`、`note-markdown-characterization` |
| 旧版转写标题与原始材料提取 | `notes/note-markdown.ts` 保留 legacy heading 解析、布局次序和旧材料白名单；共通范围扫描由 `note-document.ts` 提供 | `note-markdown-characterization`、`version-content`、`machine-block-fold` |

**A12 待维护者决定**

- **笔记索引**：① 停止自动索引，不删除笔记中的旧索引块，并保护机器块；② 保留索引写入，增加插件内读取方。§7.3 的跨纪要问答与检索提供了候选用途，优先评估复用现有索引后读取正文证据，但不等于决定永久保留笔记内嵌写入。前者减少索引刷新及额外写入机会；后者须验证读取用途、界面、更新与来源去重。实施前由维护者决定存储取舍，当前写入行为不变。
- **笔记布局**：① 通过设置迁移下线 `consolidatedLayout=false` 与 `appendPolishBlock`，减少维护路径，但曾关闭该选项的用户后续写入会得到不同结构；必须按 §4.5 保留设置，不批量改写旧笔记。② 保留两种布局，涉及笔记结构的修改须覆盖两条路径。导入强制 rewrite 的现有规则不变。

## 15. 笔记版本保存流程

`.versions` 是插件保存的可切换快照；清单和快照内容通过 Vault adapter 读取，不依赖 Obsidian 的文件索引是否返回隐藏路径。Obsidian 文件历史记录的是母本 Markdown 的实际改动，两者不是同一份版本清单。下表中的“可见正文”指母本中活动版本块外的整理正文，“原始转写”指母本的原始分段及其修订记录。

| 操作 | 入口 | 写入时刻与保存内容 | 母本可见正文 / 原始转写 | `.versions` kind 与 `activeVersionId` | 失败处理 |
|---|---|---|---|---|---|
| 录音建稿 | `RecordingService.startRecording` | 开始录音时创建母本并写标题、会话标记和空分段边界；每段转写由 `SessionFinalizeService.processSegment` 写入分段块 | 尚无整理正文；转写逐段写入母本 | 无版本快照 | 单段处理异常保留可重试任务，不阻止后续分段 |
| 首次 AI 整理 | `SessionFinalizeService._finalizeSessionImpl` → `NoteWriter.rewriteConsolidated` / `appendPolishBlock` | AI 返回后直接将成稿写入母本；重写布局替换正文，追加布局添加整理块 | 成稿成为母本可见正文；原始转写保留在原始材料区 | 不创建原稿快照；无对应 `activeVersionId` | Markdown 写入失败将任务加入后台重试；此时不会自动保留整理前的可见正文快照 |
| 普通重新整理 | `RepolishService.repolishMarkdownFile` | 先确保原稿快照及 manifest 可读、可写，再创建可见派生 Markdown，最后写 `.versions` 的 `minutes` 缓存 | 按代码不改母本正文；原始转写留在母本 | `minutes`；缓存以 `activate:false` 写入，保持原活动 ID | 原稿快照或其 manifest 验证失败时停止，不创建派生文件；派生文件已写但后续纪要缓存索引失败时保留派生文件并显示提示 |
| 清稿生成 / 再次生成 | `RepolishService.generateCleanScript` | 创建或更新清稿派生文件；首次生成前先确保原稿快照，再通过 `switchVersion` 切换母本 | 清稿成为母本可见正文；原始转写保留 | 清稿派生类型为 `clean`；切换后将清稿 ID 设为活动版本；不另存隐藏清稿缓存 | 原稿快照失败时停止生成；派生文件写入或切换失败通过任务错误路径报告。已有清稿直接切换；显式重新生成则更新同一派生文件 |
| 点击原稿或派生版本 | `OutlineView.renderRecentNoteRow` → `VersionStore.switchVersion` | 点击前读取缓存正文和 frontmatter；确保原稿安全后，在严格读取的 manifest 下改母本并更新活动 ID | 母本替换为该缓存正文；母本原始转写仍保留 | 原稿快照使用 `source-original`；派生缓存可为 `minutes`；成功切换后设为所选 ID | 缺失或损坏的类型、清单或原稿快照必须在改母本前拒绝；母本写入成功但活动 ID 写入失败属于部分提交，缓存仍保留且可再次切换 |
| 续录 | 侧边栏 / 文件菜单 / `BubbleWidget` → `RecordingService.startRecording({ appendToFile })` | 入口确定目标；悬浮气泡在点击和异步读取后都核对活动笔记。新音频与逐字稿写入独立暂存；队列确认目标路径和来源身份后，凭完整 v2 转写账本提交成稿与成功标记 | 成稿及逐字稿只写入目标；暂存只在提交、索引更新和清理成功后移除 | `pre-append`；保存时 `activate:false`，保留活动 ID | 缺少外层分段容器不阻止有效账本合入；账本损坏、来源冲突或目标变化时拒绝提交并保留恢复材料。失败进度同步到队列活动，重试按当前尝试和写回阶段显示 |
| 音频 / 文字导入 | `ImportService` 建立会话并调用 `SessionFinalizeService.finalizeSession` | 导入内容先写入新母本；转写检查通过后进入首次 AI 整理写入 | 音频导入保存 ASR 分段；文字导入保留来源文字；整理结果写母本 | 首次整理本身不创建原稿快照 | 转写检查未通过时停止 AI 整理；收尾错误保留在会话状态及任务进度中 |
| 后台合并重试 | `QueueRetryService.retryMergeTask` | 重试成功后直接重写或追加母本，再更新索引；不先归档当前可见正文 | 重试成稿写入母本；原始转写仍留在母本 | 不创建版本缓存，不更新 `activeVersionId` | 异常向队列重试路径返回；已有可见正文没有插件快照保护 |
续录暂存使用队列中保存的 `targetPath` 与 `targetSourceId`；重试不会根据当前活动笔记改写目标。`readTranscriptBlocks` 校验完整逐字稿块及其来源、版本和可见文本；追加布局在现有分段容器结束标记前插入，若缺少容器标记则接在最后一个完整转写块后。整篇布局根据已验证的账本重建原始材料区。只有目标提交路径写入续录成功标记；暂存收尾与普通整篇重写不授予该标记。

同一插件实例按来源 ID 串行执行版本缓存和活动 ID 的 manifest 读改写；它不协调 Obsidian 同步或其他插件对同一文件的写入。仅凭磁盘状态无法归因外部修改或同步冲突。

首次整理、续录和后台重试的归档差异是当前代码事实，不据此推断 Obsidian 同步或外部修改导致的历史原因。普通重新整理按代码只生成派生文件、不自动激活；若 Obsidian 实际表现不同，应先核实触发入口。用户手动修改 Markdown 的逐次历史由 Obsidian 文件历史记录，插件不追踪逐字编辑。
