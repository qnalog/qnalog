# 维护说明

本文件记录 QnALog 的维护规则与未完成事项。**改动本仓库前先读第 1、2 节。**

阅读导航：
- 新任务先看 §6（当前推进、待决定事项、人工补验）。
- **核心原则是 §1.0「录音优先」**：任何改动都不得让用户丢失录音。
- 维护规则看 §1–§5；按改动再查 §8（类型）、§9–§12（设置与服务接入）、§13–§15（架构与笔记版本）。
- 产品方向看 §7；它不是已实现功能清单，也不自动改变 §6 的执行顺序。
- 已完成事项从 Git 提交、PR 与 `.github/release-notes/` 追溯，不在本文记录。
- `AGENTS.md` 规定代理执行流程；本文件不重复维护另一套流程。
- 往本文件写入内容前先读 §0。

> English summary: QnALog is MIT-licensed software derived from LexVoice's last MIT-licensed release (2.1.2). LexVoice 2.2.0+ is proprietary; its terms do not reach this repository. Never copy code, text, or assets out of a 2.2.0+ build — implement equivalent functionality independently. Keep the plugin id `qnalog` and keep every update source pointing at this repository. Core principle: the user's recordings are the plugin's primary asset — never lose, overwrite or auto-delete a recording that may contain sound (§1.0).

---

## 0. 本文件的写入约束

本文件是公开文件，也是开发与维护的基准。写入时遵守以下规则。

1. **只写两类内容**：规则（约束、维护者已作出的决定、数据保全的不变量）与未完成事项（待办、待决定、待取证、待人工补验）。审计报告、设计推演、实验方案和验证过程写在 PR 描述或本机草稿。
2. **不写已完成事项**：完成后即从本文删除，只保留由它产生、后续改动仍须遵守的规则。历史从 Git 提交、PR 与发版说明追溯。
3. **不写动态信息**：服务价格、套餐、模型清单与默认模型、外部平台的限额等会随供应商变化的内容不写入本文；以代码（默认值、预设）和供应商当前文档为准。
4. **不写私人信息**：不写本机路径、知识库名称、账号、提交哈希，也不写某人在何时验证了什么。
5. **每个待办带状态**：§6.1 条目在标题后用括号写状态，取值为「已决定」「待决定」「取证中」「探索」「暂缓」「待规格」之一。未核实的内容标注 `[推断]`。
6. **更新即改写原文**：状态变化或设计被取代时，改写或删除已有文字，不在其后追加新段落；同一事实只在一处写全，其他位置引用章节号。写入前先搜索是否已有。
7. **引用代码写到文件或符号**，不写行号；数值类事实（文件数、键数、测试数）仅在有检查脚本核对时才写入。
8. **定期清理**：每次发版前通读一遍本文件，删除已完成条目、重复表述与和代码不符的描述。
9. **代理的修改须先确认**：代理改动本文件前，先在对话中向维护者说明改动要点并取得确认；错别字与链接修正除外。
10. **机械检查**：`tests/maintaining-doc.test.ts` 只核对能自动判定的部分——标题唯一、§6.1 条目带状态词、不含绝对路径与 40 位哈希。

---

## 1. 维护主线

QnALog 是面向 Obsidian 的开源对话智能插件：录音、转写，并把对话整理成结构化 Markdown 知识。

### 1.0 核心原则：录音优先

**录音是 QnALog 的核心资产。** 转写、整理、主题、问答等后续功能都以录音为前提：笔记、转写和索引丢了可以从录音重新生成，录音丢了就无法恢复。因此在任何情况下，先保住用户的录音，再考虑其他目标。

判断规则（所有改动、所有代理都按此执行）：

1. **录音先落盘**：只要录到了声音，即使没有网络、转写服务或 AI 模型不可用，录音也必须保存到录音目录。其他处理都在录音保存之后进行。
2. **失败不连累录音**：转写、整理、写笔记、重试、恢复、改名、清理中的任何一步失败，都不得删除、覆盖或截断录音；保留录音与可重试的任务，并告诉用户。
3. **只有能证明无内容的录音才可自动丢弃**：如不足 1 秒，或整场基本无声且转写为空白（§12）。判定须依据录音本身的声音电平，不能只看转写文本；无法证明时一律保留。
4. **拿不准就保留**：保留一段无用录音的代价是占一点空间，删除一段有用录音的代价是无法挽回。存储空间、界面整洁、处理速度与录音保全冲突时，录音保全优先。
5. **清理前先确认**：临时分片、母带或暂存材料，只有在最终录音写入完成并读回核对之后才能清理；核对不通过时保留全部材料。
6. **改动须有证据**：改动录音、分段、母带、恢复、清理或删除相关代码时，附回归测试，证明失败路径上录音仍在。

崩溃恢复、重试与自动处理的具体设计可以灵活调整，但不得违反以上规则。

三条主线按优先级排列：

### 1.1 第一条：把原有功能维护好（稳定与安全第一）

- 修 bug、修回归、修数据损坏风险、修崩溃与卡死。
- 安全相关：密钥处理、诊断输出脱敏、外部请求边界、权限与路径校验。
- 易用性：在**不改变既有行为语义**的前提下改进提示、默认值、文案与交互路径；小幅、连续、可回退。
- 判据：某项改动能降低用户数据丢失、误配置或静默失败的概率，或让既有功能在原场景下更顺，就值得做。

### 1.1.1 结构边界

- `src/main.ts` 是装配根，只负责生命周期、服务组合、Obsidian 注册与少量全局持久化协调。
- 新 service 只接收显式窄能力接口或仅含所需成员的依赖对象；不得接收完整插件、完整 `App` 或完整 `PluginSettings`。
- 视图保留 DOM 创建、渲染、局部状态与交互；领域规则和工作流归 typed module、service 或 controller。
- 队列、录音器等基础组件通过 callback、port、任务处理器或事件提供能力，不反向调用高层工作流或界面。
- 纯搬迁保留调用接收者与重绘时机，不顺带改变行为；不同刷新时机不能合并成同一种回调。
- 新增域服务时同步更新 `scripts/check-plugin-onload.mjs` 的 `DOMAIN_FIELDS`。

#### 1.1.2 QnALog 命名空间

只写 QnALog 命名空间。品牌字面量集中在 `src/shared/namespace.ts`，读侧用 `nsRe()` 生成模式；Frontmatter 写 canonical `qnalog_*` 键，按既有读取规则兼容历史字段别名。

QnALog 不承接历史项目数据：不提供笔记迁移命令，不扫描或批量改写既有笔记。pre-1.0 的 clean break 不适用于正式用户设置；设置版本迁移政策见 §4.5。

旧 API Key 混淆 marker `qnk1:` 仅用于解码旧 `data.json`；新密钥使用 Obsidian SecretStorage。磁盘混淆不是加密。

### 1.2 第二条：按需要灵活添加提升性功能

- 加功能的门槛是「确实有用」，不是「上游有」也不是「上游没有」；实现必须是本项目自己写的（§2）。
- 不追求与上游功能面对标；新功能不能把既有链路拖坏。
- 提升性功能优先围绕「利用历次对话解决当前问题」：查找依据、理解变化、准备下一次讨论，而不以增加摘要、卡片或展示形式为目标（§7）。不要求清偿全部结构债务后才开展只读的内容复用功能。

### 1.3 第三条：参照上游做相应调整

优先级最低，是参考而非目标。可以参考上游 LexVoice 的公开信息（README、Release Notes、Issue、插件公开行为）判断哪些问题值得修，并在本仓库自行实现；不跟随上游的版本节奏与功能删改。

### 1.4 硬约束（与优先级无关，不可协商）

1. **不得丢失用户的录音**：录音优先原则见 §1.0。
2. **不得复制上游 2.2.0+ 的表达**（代码、文案、注释、结构、素材），见 §2。
3. **代码与产物不得指向上游仓库**，插件 `id` 不得与社区目录条目冲突，见 §3。

---

## 2. 许可边界

### 2.1 本仓库为什么是 MIT

- 本仓库代码来自 LexVoice 以 MIT 发布的历史提交（tag `2.1.2` 及更早）。MIT 已授出的权利不可撤回。
- 上游 2.2.0 起的 `LICENSE` 第 1 节自己确认了这一点：

  > It does not revoke, replace, or restrict rights already granted for material previously released under the MIT License, including LexVoice 2.1.2 and earlier MIT-licensed releases. … Adding this license to a later release or changing a repository's visibility does not withdraw an earlier MIT grant, or rights in copies, forks, and derivative works lawfully made under that grant.

- 该专有许可只覆盖 "original LexVoice material first distributed by the copyright holder with the **2.2.0 release line or later**"，且不是 copyleft；本仓库不含这类材料（§2.3），因此不受其约束。

### 2.2 可以做与不可以做

上游许可第 3 节末段：

> These restrictions concern the Software, not independent implementations of ideas, general techniques, public APIs, or functionality as such. They do not claim exclusive rights over material that is not protected by applicable law.

| 允许 | 禁止 |
|---|---|
| 依据公开信息**自行实现**与上游新版本等价的功能 | 从 2.2.0+ 的 `main.js` / `styles.css` / 文档中**复制**代码、文案、注释、结构或资源 |
| 修改、拆分、重构本仓库内的源码 | 反编译或逐行转录专有 bundle 的实现后「还原」到本仓库 |
| 修复 bug、改善稳定性、增删功能 | 复制上游的界面素材、图标、图形或文档排版 |
| 以本项目名义发布 | 复用上游的品牌标识暗示官方身份（§2.4） |

功能思路不受版权保护，受保护的是表达。

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

### 2.4 版权声明与归属

- `LICENSE` 中的原始版权与许可声明必须保留；本仓库自己的修改版权归 Q&A Log Team，与原始声明并列，不得替换或模糊原始声明。
- 归属分布在四处，改动时一起核对：`LICENSE`（MIT 正文）、`NOTICE`（来源与修改版权）、`main.js` banner（`esbuild.config.mjs` 注入）、README 的「来源 / 许可证」章节。
- **`LICENSE` 的 MIT 正文逐字不改、不追加文字**：GitHub 按整文件识别许可证，追加内容会显示为 `NOASSERTION`，社区目录会报无许可证。
- 新增第三方依赖：在 `THIRD_PARTY_NOTICES.md` 登记许可证与用途，并保留其许可原文。
- 声明随产物分发：`npm run install:vault` 与 Release 都附带 `LICENSE` 与 `NOTICE`。

---

## 3. 项目身份与隔离

目的：**装本项目的用户不会因为误操作被换成上游版本；插件也不会自我更新。**

| 环节 | 现状 | 约束 |
|---|---|---|
| 插件 `id` / 目录 | `qnalog` / `.obsidian/plugins/qnalog/` | 上架后不可更改（改 id 会要求所有用户重装）；不得与社区目录中的 `lexvoice` 相同。 |
| 更新检查 | `src/update/update-source.ts` 常量指向 `qnalog/qnalog@main` | 不得指向上游。改动后同步 `tests/` 中的 URL 期望值。 |
| 自更新 | 已移除 | 开发者政策不允许插件 *"Install or update themselves or their dependencies"*。只检查版本并提示，安装交给 Obsidian 或 BRAT。**不得恢复写入自身文件的能力。** |
| 社区目录 | 上游 `lexvoice` 条目仍在 | 它只能被用户主动安装，不会替换本插件；README 说明两者并存时的处理。 |
| 书面名称 | 界面、提示词、生成的标题、文档、仓库简介 | 面向人阅读处一律写 **`QnALog`**（含 `manifest.json` 的 `name`）。**产品名里不得出现 `&`**：Obsidian 插件命名规范不允许该字符，macOS 原生菜单会把它当作快捷键标记。版权署名 `Q&A Log Team` 与提交显示名 `Q&A Log` 属于署名，不随产品名改。 |
| 内部标识符 | `QNALOG_*` 常量、`qnalog-*` CSS 类名与自定义属性 | 新代码不得引入 `lexvoice-*` 类名或 `LEXVOICE_*` 常量（`check:legacy-prefixes` 拦截）。 |
| 数据层 | 标签 `qnalog/*`、默认目录 `QnALog/…`、Frontmatter 业务字段 `qnalog_*`、类型值 `QnALog派生版本`、视图类型 `qnalog-*-view`、旧密钥 marker `qnk1:` 与盐 `QnALog/local-key-obfuscation/v1` | 字面量集中在 `src/shared/namespace.ts`。插件不扫描或批量改写笔记，单篇重整/更新写 canonical 键。`qnk1:` 与盐仅用于读取迁移前的 `data.json`。默认目录子目录名按界面语言在读取时取（`src/shared/defaults.ts` 的 `FOLDER_NAMES`），已保存路径优先。 |

`node scripts/check-mainline-isolation.mjs`（已并入 `npm run verify`）检查 `src/`、`scripts/`、`manifest.json`、`esbuild.config.mjs`、`package.json` 与 `main.js`：不出现上游仓库标识；`main.js` 包含本仓库更新源地址；`manifest.json` 的 id 是 `qnalog`。

`main` 是主线与默认分支；改动在本地功能分支完成并经 PR。上游产物不得留在任何分支或 tag 上。

---

## 4. 版本号与发版流程

### 4.1 版本号

- 从 `1.0.0` 起独立编号，不沿用上游版本序列；源码血缘记录在 NOTICE 与本文。
- 语义化版本 `x.y.z`（Obsidian 只接受这一格式）；破坏性改动升 minor 或 major，并在发版说明里标注。

### 4.1.1 开发分支的构建标识

开发分支编译出的构建必须能在版本号上看出是开发版。规则在 `scripts/build-identity.mjs`：

| 构建位置 | 版本标识 |
|---|---|
| `main` 且无未提交改动 | `x.y.z`（与仓库 `manifest.json` 一致） |
| 其他分支 / 有改动 | `x.y.(z+1)-dev.<分支>.<提交>[.dirty]` |
| 游离头指针 | `x.y.(z+1)-dev.detached.<提交>` |

- 仓库里的 `manifest.json` 始终是发版身份；开发标识只出现在构建产物内部（`QNALOG_BUILD_*`）与 `install:vault` 写入知识库的 manifest 副本。
- 「有改动」只算已跟踪文件有改动、或 `src/` 下有未跟踪文件；其他未跟踪草稿不影响。
- 开发版的补丁号加一：semver 中 `x.y.z-dev.*` 低于 `x.y.z`，BRAT 与 Obsidian 会用已发布的 `x.y.z` 覆盖开发安装；`x.y.(z+1)-dev.*` 只会被更新的正式版替换。
- 版本错位告警（`UpdateService.warnIfBuildManifestSkew`）比较打包进 `main.js` 的版本与 manifest 的 `x.y.z`；开发安装改用 `build-info.json` 记录的构建源版本。`build-info.json` 的 `displayVersion` 与 manifest 不一致时（更新器替换了插件但留下该文件）视为无效。

### 4.2 发版步骤

发版改动先在功能分支完成，经 PR 合并进 `main` 后再打数字 tag。推送、合并、安装与发版各自需要当前对话的明确授权；本文不构成授权。

```bash
npm version X.Y.Z --no-git-tag-version
# 更新 manifest.json；如有需要，更新 minAppVersion
node version-bump.mjs
# 编写 .github/release-notes/X.Y.Z.md，说明用户影响
# 通读 MAINTAINING.md，删除已完成条目与过期内容（§0 第 8 条）
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

**Release workflow 检查链**（不得取消）：检出 tag 的完整历史；拒绝不在 `main` 上的 tag（防止 tag 先于 `main` 更新造成发布状态不一致）；`npm ci`；校验 tag 与 manifest 版本一致；`npm run verify:push`；重建后逐字节比较 `main.js`、`manifest.json`、`styles.css`；要求 `.github/release-notes/<tag>.md`；上传 `main.js`、`manifest.json`、`styles.css`、`LICENSE`、`NOTICE`；为前三项生成构建来源证明；回读五项资产并逐字节比对。

工作流失败时不得用本地 `gh release create` 绕过；修复 tag 源码并按流程重发。发版说明写明用户影响：设置变化、服务/密钥是否需重配、功能增删。

### 4.3 安装与回滚

- `npm run install:vault -- "<知识库>"`：安装前把目标插件目录整份留档至 `<知识库>/.obsidian/qnalog-install-backups/<时间戳>/`；不得读取、移动或删除上游插件目录。
- `npm run restore:vault -- "<备份目录>" ["<知识库>"] [--set-enabled]`：回滚前另存当前目录，回滚本身可撤销。

### 4.3.1 分支验证、授权与安装

流程与授权线以 `AGENTS.md` §4 为准，本文不另写一套。补充两条：

- 纯文档、注释或行为等价的内部搬迁只免真机验证，不免推送与合并授权。
- 每次安装后同一轮用 `shasum -a 256` 比对仓库与目标 `main.js`、`styles.css`，并用 `jq -r .version` 读取目标 manifest；人工验证说明写明前置条件、入口与步骤、预期结果、实际结果及设备和版本。

### 4.4 CI

| 工作流 | 触发 | 权限与行为 |
|---|---|---|
| `validate.yml` | `main` push、PR、手动 `workflow_dispatch` | `contents: read`；`npm ci` 后只运行 `npm run verify:push` |
| `release.yml` | 数字 tag | `contents: write`；检查链见 §4.2 |

- 检查清单只有一份：`package.json` 的 `verify` / `verify:push`；workflow 里不另写检查步骤。Node 版本与 `.nvmrc`、`package.json` 的 `engines` 保持一致。
- required check 名称为 `validate`，不得改 workflow 名或 job id；ruleset 要求合并前更新到最新 `main`。
- 裸推功能分支不触发 CI。`verify:push` 比对的是 HEAD 中的 `main.js`，要求源码与产物先提交。
- `tests/validate-workflow-contract.test.ts` 核对以上约定。

### 4.5 设置结构版本政策

分界线是 **1.0.0 的发布时刻**。

| 磁盘 `schemaVersion` | 判定 | 处理 |
|---|---|---|
| = 当前 | `current` | 直接读回 |
| < 当前且 ≥ 1 | `migrate` | **跑迁移链，保留用户数据** |
| > 当前 | `future` | **不写盘**（`saveAll` 直接返回），也不改动 SecretStorage；按旧结构写回会洗掉新版字段 |
| 0 / 非数字 / 无 | `foreign` | 别的项目、pre-1.0 遗留或损坏：丢弃重建，**先把原文件复制到 `<插件目录>/settings-backups/`** |

判定与迁移链在 `src/shared/settings-schema.ts`；`loadAll` 是唯一调用点，`saveAll` 有一道 `future` 闸门。

**新增设置字段**：

- 能由 `normalizePluginSettings` 用默认值补齐的字段不升 schema；无谓升级会让旧版插件把新数据判为 `future` 而停止写盘。
- 需要结构变更时三步缺一不可：① `SETTINGS_SCHEMA_VERSION` +1；② 在 `SETTINGS_MIGRATIONS` 登记只负责那一次变更的迁移，**不重建整个对象**；③ 在 `tests/settings-schema-policy.test.ts` 加「旧版 data.json → 用户配置仍在」的用例。
- 缺链时 `migrateSettingsForward` 返回 `null`，调用方不写盘：宁可停在可读状态，也不用一半的迁移结果覆盖配置。
- 不把 pre-1.0 或 LexVoice 的数据接回迁移链，那些版本走 `foreign`。

**密钥**：`loadAll` 先恢复或导入 API Key；只有 SecretStorage 写入成功后，`saveAll` 才清空设置快照中的密钥字段，写入失败时只替换已落盘数据中的 `backgroundJobs`。SecretStorage 没有删除方法，清除密钥时写入空值。`security.apiKeyStorageNamespace` 区分不同知识库的 SecretStorage 条目。

**回归防线**：`scripts/check-plugin-onload.mjs` 用一份 1.0.0 用户的 `data.json` 驱动真实的 `loadAll`，断言密钥/模型/队列都在、`future` 时零写盘、`foreign` 时回默认值。

## 5. 同步上游

- 只可从 LexVoice 最后一次 MIT 提交（`d924e439`）及其祖先中取材。
- LexVoice `2.2.0` 之后的实现不可参考代码，只能参考公开描述；同一处缺陷按本仓库源码自行修复。
- 若上游将来把某次提交以 MIT 形式单独发布，取材时在提交信息中记录证据（上游 commit sha、当时的 `LICENSE`）。

---

## 6. 当前任务与状态

本节是未完成事项的唯一入口。完成即删除，历史从 Git、PR 与发版说明追溯。

### 6.1 当前推进

1. **主题层后续**（暂缓）。近似重复要点（措辞不同、事实相同）仍可能同时加入，目前靠预览里取消勾选处理；纪要列表可考虑「展开概要」；已合并的聚类建议暂不使用。
2. **长录音转写异常的真实来源**（取证中）。写入母本前的拦截已实现（阈值见 `audio/long-recording-anomaly.ts`）；真实转写服务是否会产生此类输出仍未证实，阈值是否调整取决于取证结果。

### 6.2 待决定、待确认与暂停项

- **多说话人确认**（待决定）。检测到多个未命名说话人时，整理等待姓名确认（`notes/speaker-confirmation-flow.ts`）。是否先以会话内编号整理、之后再命名，由维护者决定。
- **A12 笔记索引与布局**（待决定）：选项与代价见 §14.3；当前写入行为不变。
- **全库问答**（探索，不进入开发）：范围与退出条件见 §7.3。
- **条件调查**：机器数据展示与历史 `partial` 原因按 §6.3 的授权与取证边界执行。`invalid-json` 不证明磁盘 JSON 损坏；不删除状态标记、不伪造 `complete`。尚未定位的截图或 `partial` 状态不作为已定位故障。
- **暂停或可选**（不排入当前执行队列）：`modals.ts` 按域拆包、更新检查薄转发、专属服务展示、整体 `OutlineView` 拆分；Host 宽能力存量收窄与类型收敛（`SessionFinalizeService`、`QueueRetryService`、`RepolishService` 外壳，`NoteWriter` 材料编排与 `RecordingService` 启停）；三个 `@ts-nocheck` 文件（条件见 §8）；门禁正则漏检或 CSS 类名/产物大小问题（只在出现证据或真实输出问题时启动）；服务推荐（有具体需求时再核实能力、地区与费用）；历史流式任务恢复（有实际恢复需求时再调查）。
- 真实用户数据损坏或安全问题优先于以上各项。

### 6.3 人工补验清单

相关改动或取证获得授权时执行，不阻塞无关离线改动。维护者确认才算真实宿主验收；自动模拟不代验。没有条件时只记录自动测试覆盖，不宣称真机验收。完成的项从本清单删除。

1. **录音与正文路径**：普通录音的暂停、恢复、停止；不足 1 秒、1–10 秒空白与有声、10 秒与 60 秒以上空白、断网录音；音频与文字导入；服务中断后手动重试不重复追加；续录准备期间切换活动笔记只写原定目标；续录遇空白或异常结果时原笔记不变；流式服务下的失败任务恢复。正文保全需固定返回含 `$&`、`` $` ``、`$'`、`$$` 文本的测试转写服务，确认结束标记后的正文未截断、文本按字面量保存。
2. **录音中断恢复**：真实麦克风采集、进程强制退出、移动端。
3. **主题与删除**：进程强制退出与移动端。
4. **重试与密钥保存**：重试整理期间编辑笔记不被覆盖；SecretStorage 写入失败时队列仍保存。
5. **机器数据展示**：在源码、实时预览、阅读视图中分别记录会话知识、索引与活动版本标记是否占正文；切换版本前后核对机器数据可读、活动范围未删除。只调查，不修复笔记。
6. **历史 `partial` 原因**：取得日志与服务授权后，区分非合法 JSON、响应结构不符和后续保存异常；找不到历史响应记「原因未核实」。不改为 `complete`，不重跑原笔记。
7. **设置迁移**：用真实旧版 `data.json` 在 Obsidian 中确认升级后用户配置仍在。
8. **移动端 Q 图标**：确认工具栏/侧栏入口的 Q 可辨识、未裁切且点击打开正确视图，记录系统与版本。

## 7. 产品方向与功能边界

### 7.1 方向

**从整理一次对话，扩展到利用历次对话查找依据、理解变化，并准备下一次讨论。** 录音、可靠转写与原始材料保全仍是基础；内容复用以用户要解决的问题为单位，不以合并整个目录或生成更多文件为目标。用户不需要手动筛选资料。

### 7.2 用户任务与判断边界

- **查证与综合**：查证回答「哪次讨论提到什么」，优先返回来源原文；综合回答「几次讨论为什么得出某个结论」，须列出依据、分歧和证据不足之处。两者都显示实际资料范围，不暗示已查遍知识库。
- **持续主题回顾**：查看有依据的结论、变化、未解决问题与相关行动。后来的说法不自动替代早先决定；区分补充、适用条件不同、分歧、明确替代和模型推断。
- **准备下一次讨论**：会前整理已确认事项、进展与待追问问题；会中由用户主动查询历史；会后提出与历史相比的变化候选。历史材料不混入本次原始转写，更新主题、人员或待办须经确认。
- **可选主动提示**：在前述能力得到验证后，再评估反复未解的问题、不同说法及后续事项提示。「未找到完成记录」不等于「没有完成」；不自动勾选任务、认定责任人、合并同名人物或执行外部行动。

### 7.3 主题层约束与全库问答探索

**主题层改动须保持**：原笔记不改；来源可回溯到脚注；成员由用户确认；用户编辑不被覆盖；更新先预览、可撤销；冲突并列呈现而不合并；段落修订通过预览和块级校验；请求额度估算可见；主题页不进入候选语料；概要卡片按变更增量重算，不全量重算。应用与写回前核对主题文件夹、目标路径与主题 ID；勘误与撤销关联写入后读回确认。页面、勘误与缓存写入不具原子性，追加结果无法确认时须提示而不是假定成功。

**探索项：全库问答（未进入开发阶段）**

- **性质**：调研与小规模功能验证。不排功能开发、不新增界面、不落盘新索引。
- **约束**：利用已有关系信息（双链、共享标签、主题成员、人员、同源版本、索引卡）建立轻量关系结构并据此取候选；不引入整库向量化与重型检索增强生成（RAG）管线。
- **待调研**：哪些关系信息足以连接相关笔记；关系结构能否从现有文件重建、成本多大；用固定问题集比较「词法检索加索引卡」与「再加关系扩展」的必要来源召回。
- **验证形式**：合成笔记集上的离线原型与一份短调研记录；不访问真实知识库。
- **退出条件**：找到可行方案后，由维护者决定是否转为开发并写入 §6.1；未找到则保留单篇问答与主题层。
- **转入开发的前置条件**：索引卡读取时核对当前来源修订（`topics/overview-card.ts` 与 `indexing/related-notes-corpus.ts` 现不核对）；引用带转写时间精度；同源版本只计一份来源。

### 7.4 数据、实现与隐私边界

每批开发应包含一个完整的用户场景：入口、读取范围、结果、失败边界和验证。检索先用分块、关键词、中文字符二元切分和索引卡；不先建设脱离用户用途的基础设施。

**资料范围不等于目录前缀。** `QnALog/` 是可配置的默认路径，同时包含纪要、录音、对象、报告、归档及运行数据。新增功能遵守：

1. **明确范围**：默认读取 `QnALog/`；扩大到整个知识库须在设置中明确开启。说明发送给模型的内容、模型服务及费用；纪要、人工补充和已确认对象须标明来源性质。缓存、诊断日志和队列不参与内容检索。
2. **来源去重**：同一录音的纪要、清稿、重整版本和报告不构成多份独立证据。历史 AI 回答不得证明自身；综合结果须追溯原始来源。复用已有来源与版本关系，不另造身份体系。引用须带转写时间精度（`provider`、`audio-span`、`segment`、`unknown`）；精度只到段时显示「约在此段」。
3. **读取职责**：先确定允许范围，再查找候选笔记，读取相关正文与转写证据，最后生成回答。转写模块保留来源与修订所有权，会话知识模块保留证据校验与状态；界面只展示范围、来源和确认操作。不把工作流加入 `main.ts`、`OutlineView` 或底层索引模块。
4. **检索选择**：优先标题、主题、正文、人员、时间及关键词检索，覆盖中文与别名；只有代表性问题的漏检证明需要时，再增加向量检索。现有索引是候选读取基础，不是完整知识数据库。
5. **保全与降级**：检索缓存须能从来源文件重建，删除缓存不丢失用户知识。来源修改、删除、重命名或切换版本后重新判断引用有效性；旧笔记缺少结构化知识时按正文查找并说明引用精度，不强制批量重整，不伪造完整状态。待办完成态以 Markdown 任务状态为准。
6. **授权与服务**：本地检索范围和发送给模型的内容分别说明并授权；展示本次来源、模型服务及材料规模，提供取消入口。可选付费服务的边界见 §7.7。
7. **只读默认**：回答不改源笔记；保存结果或更新对象须显式操作。笔记中的命令或提示词只是资料，不授予工具权限。新功能上线时同步更新 README 与隐私说明。

### 7.5 价值验证与暂不优先的方向

用经授权的代表性资料与人工问题集评估：找到可核对答案的时间、引用是否支持结论、必要来源是否遗漏、回顾是否被再次使用，以及等待时间、费用和纠正成本。问题集应包含无答案、不同说法、派生重复、来源变化与旧笔记缺结构的情况。不按生成文件数或提取条数验收，不为评估新增遥测。自动测试、真实模型评估与真实 Obsidian 验证互不替代。

暂不优先：全库自动知识图谱、批量卡片/摘要/周报、通用聊天助手、完整任务或客户管理系统、自主修改知识库的 Agent。

### 7.6 已裁剪场景的保全规则

招聘、晋升及学习卡片入口已移除；学习笔记模式保留。裁剪不授权删除、扫描或批量改写用户已有文件；未知历史模式必须安全降级。重新增加场景时需提供完整的提示词、设置登记与测试。新增内容提取必须同时定义后续使用入口。

### 7.7 商业化边界

QnALog 长期以 MIT 开源维护，可审计性是隐私承诺的依据。可能的收费只来自插件之外的可选层（托管服务、加密录音备份、部署与支持、赞助、内容），不来自插件功能本身。

1. 不闭源插件代码，不更换许可证，不为现有或新增功能设付费门槛。
2. 自带密钥、无需账号的用法始终完整可用；托管服务只以配置预设的形式出现，走现有 endpoint 校验，不设功能开关，不是任何功能的唯一入口，也不是内容复用的前置条件。
3. 插件不加遥测、广告或行为分析；不出售用户数据，不用用户内容训练模型。
4. 提供任何托管服务前，先改写 `PRIVACY.md` 与两份 README 中「没有自营后端」的表述，写明数据流向、留存、地域和服务方。

## 8. 类型检查边界

- 三个仍带 `@ts-nocheck` 的文件为 `asr/clients.ts`、`ui/modals.ts`、`ui/settings-tab.ts`。暂停退出；只在结构性改动需要或出现只有类型检查才能拦截的回归时单独重启。新文件不得使用 `@ts-nocheck`。
- 常规 `tsc`、`check:undefined-symbols`（`@ts-nocheck` 文件中的未定义引用）与 `typecheck:core`（`tsconfig.strict-core.json`）覆盖范围不同，不互相替代。
- 估算某个 `@ts-nocheck` 文件的退出成本：用 TypeScript `CompilerHost` 在内存中移除指令并读取诊断；过滤 TS2304 只用于区分已有门禁，不得掩盖真实错误。
- 常见修法：跨模块读取的 class state 显式声明字段（多用 `declare`）；用联合类型收窄表达变体差异；修正缺失的联合成员或参数可选性。不能为消除诊断改变真实行为。

## 9. 设置映射表

### 9.1 逐键映射

`PluginSettings` 全部顶层键的落盘位置；`scripts/check-settings-map.mjs` 核对键集合与落盘路径（第 3 列），已并入 `verify`。默认值见 `src/shared/defaults.ts`，读写白名单见 `src/shared/settings-io.ts`。新增设置键必须同步登记 `normalizePluginSettings` 与 `serializePluginSettings`，否则读写会丢失该键。

| 设置键 | 作用 | 落盘位置 | 读回别名 |
|---|---|---|---|
| `uiLanguage` | 界面语言；空串表示跟随 Obsidian | `ui.language` | — |
| `audioFolder` | 录音文件落盘目录 | `storage.recordingLibraryPath` | — |
| `mdFolder` | 纪要 Markdown 落盘目录 | `storage.briefingNotePath` | — |
| `meetingMaterialsFolder` | 会议材料导入目录 | `storage.meetingMaterialPath` | — |
| `topicsFolder` | 主题页文件夹，默认路径按界面语言选择 | `storage.topicsFolder` | — |
| `noteFileNameFormatNew` | 纪要文件名日期格式 | `noteNaming.sessionPattern` | — |
| `apiKeyStorageNamespace` | 区分不同知识库的 SecretStorage 条目；内部字段，不进设置界面 | `security.apiKeyStorageNamespace` | — |
| `transcribeEndpoint` | 兼容兜底：provider 未填地址时的回退；内部字段，不进设置界面 | `speech.compatEndpoint` | — |
| `transcribeApiKey` | 兼容兜底：provider 未填密钥时的回退；内部字段，不进设置界面 | `speech.compatApiKey` | — |
| `transcribeModel` | 兼容兜底：provider 未填模型时的回退；内部字段，不进设置界面 | `speech.compatModel` | — |
| `transcribeLanguage` | 兼容兜底：provider 未填语言时的回退；内部字段，不进设置界面 | `speech.compatLanguage` | — |
| `activeTranscribeProvider` | 实时录音使用的转写服务 id | `speech.activeProviderId` | — |
| `importTranscribeProvider` | 导入音频（整文件）使用的转写服务 id | `speech.importProviderId` | — |
| `importSpeakerDiarization` | 导入音频是否区分说话人（可选项，默认不启用） | `speech.importSpeakerDiarization` | — |
| `importSpeakerCount` | 导入音频预期的说话人数（0=自动） | `speech.importSpeakerCount` | — |
| `transcribeProviders` | 各转写服务的地址/密钥/模型/语言注册表 | `speech.providers` | — |
| `llmEndpoint` | AI 整理服务地址 | `composer.endpoint` | — |
| `llmApiKey` | AI 整理服务访问密钥 | `composer.apiKey` | — |
| `llmModel` | AI 整理模型标识 | `composer.model` | — |
| `llmServicePreset` | 服务预设 id，用于填地址与请求头适配 | `composer.servicePreset` | — |
| `llmProfiles` | 已保存的 API 方案（转写+AI 整理为一套） | `composer.profiles` | — |
| `activeLlmProfile` | 当前启用的 API 方案 id | `composer.activeProfile` | — |
| `polishMode` | 默认整理方式 | `composer.defaultMode` | — |
| `polishPromptInterview` | 该模式的提示词回退来源：模板为空时使用（`legacyPromptFieldForMode`）；内部字段，不进设置界面 | `composer.modePromptOverrides.interview` | `promptOverrides.interview` |
| `polishPromptMeeting` | 同上（Meeting 模式的回退提示词）；内部字段，不进设置界面 | `composer.modePromptOverrides.meeting` | `promptOverrides.meeting` |
| `polishPromptHuddle` | 同上（Huddle 模式的回退提示词）；内部字段，不进设置界面 | `composer.modePromptOverrides.huddle` | `promptOverrides.huddle` |
| `polishPromptSeminar` | 同上（Seminar 模式的回退提示词）；内部字段，不进设置界面 | `composer.modePromptOverrides.seminar` | `promptOverrides.seminar` |
| `polishPromptMonologue` | 同上（Monologue 模式的回退提示词）；内部字段，不进设置界面 | `composer.modePromptOverrides.monologue` | `promptOverrides.monologue` |
| `polishPromptLearning` | 同上（Learning 模式的回退提示词）；内部字段，不进设置界面 | `composer.modePromptOverrides.learning` | `promptOverrides.learning` |
| `promptTemplates` | 提示词模板库（内置 + 自定义） | `promptTemplates` | — |
| `activeTemplateByMode` | 每种模式当前启用的模板 id | `activeTemplateByMode` | — |
| `briefingStructureLevel` | 纪要结构化程度（宽松/均衡/严谨） | `composer.structureLevel` | — |
| `repolishPreferencePromptAddendum` | 「重新整理为」的追加规则 | `composer.repolishPreferencePromptAddendum` | — |
| `repolishPreference` | 当前选中的重新整理偏好 | `composer.repolishPreference` | — |
| `thinkingMode` | 思考档（auto/reasoning/fast） | `composer.thinkingMode` | — |
| `briefingTranslationMode` | 纪要语言策略（跟随原文/统一/双语） | `composer.languagePolicy.mode` | `languagePolicy.mode` |
| `briefingTargetLanguage` | 目标语言 | `composer.languagePolicy.targetLanguage` | `languagePolicy.targetLanguage` |
| `briefingCustomLanguage` | 自定义目标语言 | `composer.languagePolicy.customLanguage` | `languagePolicy.customLanguage` |
| `briefingKeepOriginalTerms` | 保留专有名词原文 | `composer.languagePolicy.keepOriginalTerms` | `languagePolicy.keepOriginalTerms` |
| `briefingLanguageInstruction` | 额外语言要求 | `composer.languagePolicy.extraInstruction` | `languagePolicy.extraInstruction` |
| `industryProfile` | 行业档案，由词汇表服务生成；内部字段，不进设置界面 | `composer.industryProfile` | — |
| `customVocabulary` | 内联 ASR 热词 | `vocabulary.inlineTerms` | — |
| `vocabularyFile` | 热词表文件路径 | `vocabulary.notePath` | — |
| `peopleDirectoryFolder` | 人员资料文件夹 | `vocabulary.peopleFolder` | — |
| `peopleBaseFile` | 人员库 .base 文件路径 | `vocabulary.peopleBasePath` | — |
| `sedimentAutoExtract` | 转写/整理完成后是否自动沉淀 | `noteNaming.sedimentAutoExtract` | — |
| `basesFolder` | Base 视图文件夹 | `views.baseFolder` | — |
| `peopleContextMode` | 人员资料是否随请求发送（隐私优先/人名热词/本地增强） | `vocabulary.peopleContextMode` | — |
| `peopleHotwordsConsentAt` | 人名热词授权时间；内部字段，不进设置界面 | `vocabulary.peopleHotwordsConsentAt` | — |
| `peopleSuggestionIgnores` | 已忽略的人员建议；内部字段，不进设置界面 | `vocabulary.peopleSuggestionIgnores` | — |
| `peopleSuggestionCache` | 待确认人员建议缓存；内部字段，不进设置界面 | `vocabulary.peopleSuggestionCache` | — |
| `knowledgeExtractionHistory` | 人员/词表扫描记录；内部字段，不进设置界面 | `vocabulary.extractionHistory` | — |
| `inboxFolder` | 外部收件箱监听目录 | `storage.inboxPath` | — |
| `inboxAutoImport` | 是否自动处理新音频 | `storage.autoImportInbox` | — |
| `inboxArchiveSubfolder` | 处理完成后移入的子文件夹 | `storage.archiveSubfolder` | — |
| `inboxStabilizeDelayMs` | 开始处理前的等待毫秒数 | `storage.syncQuietMs` | — |
| `enableInterimOutput` | 录音过程中是否切段实时转写 | `capture.liveSegmentsEnabled` | — |
| `segmentIntervalMinutes` | 切段间隔（分钟） | `capture.segmentMinutes` | — |
| `asrConcurrency` | 导入长音频的并发转写数 | `speech.asrConcurrency` | — |
| `segmentCacheFolder` | 分段音频临时缓存目录 | `storage.segmentCachePath` | — |
| `keepSegmentAudioFiles` | 是否保留临时分段音频（排障用） | `capture.keepSegmentAudioFiles` | — |
| `filterShortRecordings` | 短录音保护：不足 1 秒丢弃；1–10 秒转写一次再按内容判定 | `capture.discardVeryShortRecordings` | — |
| `captureMode` | 录音来源（麦克风/混合/电脑音频） | `capture.sourceMode` | — |
| `audioChannelMode` | 是否按声道区分说话人 | `capture.channelMode` | — |
| `selectedVirtualDevice` | 电脑音频输入设备 id | `capture.virtualDeviceId` | — |
| `selectedMicrophoneDevice` | 麦克风设备 id | `capture.microphoneDeviceId` | — |
| `enableRealtimeOutline` | 转写后是否自动更新实时大纲 | `liveOutline.enabled` | — |
| `realtimeOutlineDebounceMs` | 实时大纲请求防抖毫秒数 | `liveOutline.debounceMs` | — |
| `autoOpenOutlineOnRecord` | 录音开始时是否自动打开侧边栏 | `liveOutline.openOnCapture` | — |
| `setupWizardDismissed` | 关闭过首次配置向导后不再自动弹出；首页的向导按钮不受它控制 | `setupWizardDismissed` | — |
| `autoRenameWithTitle` | 是否用 AI 提炼主题追加到文件名 | `noteNaming.renameWithTitle` | — |
| `consolidatedLayout` | 纪要是否整合排版（顶部整合、底部原始分段） | `noteNaming.consolidatedLayout` | — |
| `maxRetries` | 转写/整理任务的自动重试上限 | `retryPolicy.maxAttempts` | — |
| `diagnosticsLogEnabled` | 是否写本地诊断日志 | `diagnostics.enabled` | — |
| `diagnosticsLogFolder` | 诊断日志目录 | `diagnostics.folder` | — |
| `showFloatingBall` | 是否常驻显示桌面悬浮按钮 | `ui.floatingControlEnabled` | — |
| `bubbleSize` | 悬浮按钮大小 | `ui.bubbleSize` | — |
| `floatingBallPos` | 悬浮按钮位置（拖动写入）；内部字段，不进设置界面 | `ui.floatingControlPosition` | — |
| `autoOpenNoteAfterFinish` | 处理完成后是否自动打开纪要 | `noteNaming.openAfterFinish` | — |
| `lastUpdateCheckAt` | 上次检查更新时间；内部字段，不进设置界面 | `updates.lastCheckedAt` | — |
| `availableUpdate` | 已发现的可用更新；内部字段，不进设置界面 | `updates.available` | — |
| `lastUpdateError` | 上次检查失败原因；内部字段，不进设置界面 | `updates.lastError` | — |
| `installedUpdateVersion` | 当前已安装版本记录；内部字段，不进设置界面 | `updates.installedVersion` | — |

### 9.2 设置改动约束

1. 一次只解决一个明确问题；不把设置页改造与录音流程重构捆绑。
2. 设置只有一套实际存储；不同界面读写同一组字段，不新增同步副本。
3. 预设只写服务配置所需字段，不覆盖目录、提示词、设备或自动化偏好（§10.1）。
4. 配置修改、转换与检测各有单一实现；检测候选配置，不写盘。
5. 不引入通用表单框架、预设市场或新依赖。
6. 新业务逻辑放有类型检查的模块，不以退出 `settings-tab.ts` 的 `@ts-nocheck` 为前置条件（§8）。
7. 测试覆盖用户后果：无效密钥、部分服务失败、取消、重启读回及已有配置保留。设置 schema 改动遵守 §4.5。

---

## 10. 首次配置：预设、检测与四态

实现在 `src/setup/index.ts`（有类型检查），行为测试在 `tests/setup.test.ts`。

### 10.1 预设改哪些字段

预设**只写完成服务配置所需的键**，清单集中在 `PRESET_WRITTEN_FIELDS`；`tests/setup.test.ts` 用一份「用户已经改过很多项」的设置逐键核对清单之外的键不变。

- **不改用户已选的转写语言**：`language` 只在用户没设过时才用默认值。
- **说话人识别按供应商区分**：预设自带支持说话人识别的导入服务时写为启用，否则写为未启用；默认值为未启用。
- **密钥为空时不覆盖**：「先套推荐配置、再填密钥」的入口（`allowMissingKey`）只写地址与模型。
- 选择服务预设时清空活动方案与旧服务密钥；向导只在地址匹配时回填已存密钥。

### 10.2 检测对象是候选配置

`planPresetApplication` 算出计划 → `applyPresetPlan` 得到候选设置 → `buildProbeHost` 构造检测宿主。测的是用户正在填的值，不是磁盘上已保存的配置。`buildProbeHost` 的 `saveSettings` / `saveAll` 指向拒绝函数：检测若试图写盘会直接失败。用户点「检测」不等于同意保存。

### 10.3 四态

| 状态 | 判定 |
|---|---|
| 缺配置 | `setupServiceIssue` 非空（端点、模型或云端服务的密钥没填；本地服务可省密钥） |
| 未测试 | 无结果，或配置指纹已变 |
| 已通过 | 结果 `ok` 且指纹一致 |
| 未通过 | 结果不 `ok` 且指纹一致 |

指纹 = 端点 + 模型 + 密钥摘要（密钥只进散列）。结果只存在内存（`_probeResults`），不落盘。徽章只用 `is-ready` / `is-missing` 两种配色，四态差别由文字承担。首页使用状态（`buildSetupStatus`）只看是否缺配置，警告不算 blocker，不参与四态。

### 10.4 取消与失败不覆盖已有配置

- **取消**：计划是纯函数，应用前丢弃计划即可，磁盘逐项不变。
- **检测失败**：只记录结果，不写入任何设置；用户已填的密钥不被清空。
- **快捷配置**：只有候选配置的检测全部通过才保存；「仅检测」与未点「应用」都不写盘。

---

## 11. 转写服务接入规则

当前供应商、预设、默认模型与地址以 `src/llm/config.ts`、`src/asr/bailian-asr-registry.ts` 与 `src/ui/settings-tab.ts` 为准，本文不抄录。

### 11.1 百炼

- **不改写已保存配置**：预设默认值只用于新建配置和用户主动应用的方案；设置加载不改写已保存的模型、地址、密钥、活动服务、语言或方案快照。
- **协议按登记表选择**：只有命中 `bailian-asr-registry.ts` 登记项的模型，选择器才写入对应 endpoint 与协议；转换保留当前 host、区域和代理前缀，不猜测默认 host。未登记模型可手动输入，但不自动改用百炼协议。旧 `dashscope-chat`（`qwen3-asr-flash`，Chat Completions）与原生短音频 HTTP 是不同服务，不能互换模型与 endpoint。
- **模型目录全有或全无**：分页目录必须完整读取；页码、总数不一致或任一页失败时报告目录失败，不返回部分结果、不拼接静态清单。
- **整文件与流式**：文件转写接收整段音频，录音分段间隔不拆分该请求，失败或重试重新发送保留的完整音频。流式模型不降级到 HTTP multipart。单句任务模型（如 `gummy-chat-v1`）由客户端按输入时长结束并新建任务，交接期间暂存未发送的 PCM 帧。
- **短音频请求**：语言未指定时省略 `language_hints`；只有从 WAV 头部读到采样率时才发送 `sample_rate`，原样上传的 WebM/MP4 不标记采样率；Data URI 使用规范化 `audio/<format>` MIME，不附带 `codecs` 参数。不另指定服务方的其他平台域名，也不假定不同平台的 API Key 通用。
- **上传预算**：客户端保守使用 10,000,000 字节 Base64 预算与 3 分钟 WAV 分块（常量见代码）；这不是官方文件规格，不随官方上限放宽。
- **连通性检测**用一段静音录音；百炼返回 `ASR_RESPONSE_HAVE_NO_WORDS` 视为请求已通过鉴权。这只验证连接，不验证识别效果。
- **费用**：不在本文或界面中写固定价格，也不折算成固定每小时价格或宣称最便宜；费用以服务方价格页与账单为准。
- **官方资料**：[短音频原生 HTTP API](https://help.aliyun.com/zh/model-studio/fun-asr-flash-recorded-speech-recognition-http-api)、[整文件 HTTP API](https://help.aliyun.com/zh/model-studio/fun-asr-recorded-speech-recognition-http-api)、[Streaming WebSocket 指南](https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api)、[模型调用价格](https://help.aliyun.com/zh/model-studio/model-pricing)。

### 11.2 协议参数

`disfluency_removal_enabled` 只发给 Paraformer 实时模型；`language_hints` 只对登记且接受语种参数的模型发送；8 kHz 型号的采样率同时用于音频编码和 `parameters.sample_rate`。参数构造在 `src/asr/realtime-params.ts`，由 `tests/realtime-params.test.ts` 覆盖。

### 11.3 OpenRouter

录音转写使用 multipart；导入音频的说话人分离通过 JSON 发送嵌套 `provider.options`，响应使用 `verbose_json` 并读取 `segments[].speaker`。上游 slug 按模型端点运行时查询；协议适配在 `src/asr/openrouter-diarize.ts`，能力判断按协议而非固定 provider id（`src/asr/diarization.ts`）。

### 11.4 平台限制

HTTP 分段转写支持桌面与移动端；实时 WebSocket 需要浏览器不提供的鉴权头，只在桌面端可用。

### 11.5 连通性检测按协议区分

流式服务的检测执行 WebSocket 握手，HTTP 服务使用上传检测；不得把 `wss://` 地址交给 HTTP 上传。endpoint 按协议校验，不放宽明文传输与内网限制。回归覆盖见 `tests/endpoint-transport.test.ts`、`tests/bailian-setup.test.ts`。

### 11.6 流式服务与历史分段任务

已录制的 HTTP 分段不能交给实时流式服务处理：`describeSegmentRetryUnavailable`（`src/queue/queue-retry-service.ts`）在可确认当前服务为流式协议时给出说明；无法读取服务档案时不拒绝重试（`tests/segment-retry-guard.test.ts`）。

### 11.7 音频设备

- 分类纯函数在 `src/audio/audio-input.ts`；设备枚举、授权申请和设置交互由 UI/宿主负责。
- 分类只供参考，不自动选择设备。缺少设备名称与没有输入设备是不同状态。
- `enumerateDevices()` 不申请权限；只有用户主动打开设备选择或触发检测时才请求名称权限。

## 12. 录音收尾的保留规则

本节是 §1.0 录音优先原则在当前代码中的具体规则。

- 不足 1 秒丢弃且不转写；1–10 秒转写一次后按内容判定，转写失败保留音频与重试任务（`audio/short-recording-policy.ts`、`audio/short-recording-content.ts`）。
- 整场有声比例按 `audio/session-silence.ts` 判定。普通录音转写全空、整场基本无声且不足 60 秒时丢弃笔记与音频；有声或达到 60 秒时保留并写入「未检测到语音」。导入音频与续录不丢弃。
- 低音量块的连续空结果（`QUIET_AUDIO_RMS_LIMIT`）与百炼「无语音」错误按成功的空白段处理；标记字段 `quiet` / `noSpeech` 不写入笔记与转写账本。
- 长录音写入母本前按 `audio/long-recording-anomaly.ts` 的阈值拦截异常文本，拦截后保留音频与失败任务。
- 录音母带逐片保存；恢复发布经 stage、pending、final 三阶段，每阶段读回核对；无法证明目标与源分片相同时保留材料，不覆盖最终目标（`audio/master-partial*.ts`）。完整性只按文件类型、字节数与内容核对，不检查音频可解码性。

## 13. 架构门禁：check:architecture 与基线制

`npm run check:architecture` 与 `check:domain-boundaries` 一起检查依赖方向：前者判断依赖是否扩大，后者判断引用能力是否真实存在。两者并入 `npm run build`。

### 13.1 基线规则

`scripts/architecture-baseline.json` 记录现有依赖事实；测试见 `tests/architecture-gate.test.ts`。门禁核对：

1. `pluginConsumers`：禁止新增 `src/main.ts` import；冻结遗留消费者对完整插件对象的 `plugin.*` 使用集合。
2. `serviceEdges`：按 Host 接口和装配服务识别依赖边；新增边、新环或扩大既有环失败。
3. `uiImportsFromNonUi`：冻结非 UI 模块对 `src/ui/` 的直接依赖。
4. `hostCapabilities`：冻结 Host 接口对完整 `PluginSettings` 或完整 `obsidian.App` 的直接属性。
5. 基线字段变更须与代码一起人工审查；已有债务可保持或收缩，不得无审查扩大。

服务依赖图是静态检查，不是完整运行时依赖审计；Host 检查不穿透类型别名、继承、重新导出或结构等价类型。

### 13.2 基线更新

基线不自动刷新。新增依赖前先确认方向，优先 callback、port 或独立 workflow service；再用 `node scripts/check-architecture.mjs --print-baseline` 生成数据，人工审查后与代码改动一起提交。删除依赖时同步收缩基线。

### 13.3 检查范围

门禁不检查文件行数、方法数量、`shared/` 层级或全运行时依赖关系。

## 14. 架构保留设计与待决

### 14.1 保留设计

- `src/main.ts` 保持装配根；`saveAll` 保持串行尾链；纪要分部断点先写 `.tmp` 再改名。
- `src/notes/outline-text.ts` 保持纯函数，不依赖 Obsidian、DOM 或文件读写。
- OutlineView 的 `scheduleUpdate()` 与 `render()` 重绘时机不同，不合并。
- i18n 以英文原文为键；英文 locale 文件为空是有意设计。
- ASR、LLM、队列三层重试分别处理服务不可用、模型请求与任务恢复，不合并。
- `settings-io.ts` 读取 `update-source` 是有意依赖。
- 不启动全仓命名搬迁；不因未引用 CSS 类名数量启动清理。

### 14.2 笔记结构归属（A6）

`notes/note-document.ts` 只提供通用位置/范围操作；协议语义留在各领域模块：

| 结构 | 归属与边界 | 消费者与现有验证 |
|---|---|---|
| 外层前言、活动版本、details/heading、会话范围、字面标记偏移、原始材料插入位置 | `notes/note-document.ts` 只返回结构范围/位置；调用者决定追加、替换、错误和写盘策略 | `note-markdown.ts`、`note-writer.ts`、`queue-retry-service.ts`、`meeting-workbench-service.ts`、`version-content.ts`；对应消费者测试覆盖 |
| 带来源 ID、修订记录和可见正文配对的逐字稿账本 | `transcript/transcript-markdown.ts` 保留 source/revision/evidence 验证、正文/JSON 顺序、损坏拒写与尾部恢复；不替换为通用配对扫描 | `session-transcript`、`asr-transcript-result`、`continuation-commit`、`transcript-queue-retry` |
| 会话知识 HTML 注释及证据状态 | `briefing/session-knowledge.ts` 保留 JSON schema、证据校验、`partial`/`stale` 状态和 malformed 处理 | `session-knowledge`、`text-correction`、`note-index` |
| 笔记索引与沉淀机器壳 | `indexing/note-index.ts` 与 `sediment/` 分别拥有各自 JSON/容器格式；仅共用通用 details 范围，不搬 schema | `note-index`、`machine-block-fold`、`note-markdown-characterization` |
| 旧版转写标题与原始材料提取 | `notes/note-markdown.ts` 保留 legacy heading 解析、布局次序和旧材料白名单；共通范围扫描由 `note-document.ts` 提供 | `note-markdown-characterization`、`version-content`、`machine-block-fold` |

### 14.3 A12 待维护者决定

- **笔记索引**：① 停止自动索引，不删除笔记中的旧索引块，并保护机器块；② 保留索引写入。索引卡已有两个读取方（`indexing/related-notes-corpus.ts`、`topics/overview-card.ts`），均不核对当前正文；全库问答（§7.3）如复用索引卡，须先补读时校验。前者减少索引刷新及额外写入；后者须验证读取用途、界面、更新与来源去重。
- **笔记布局**：① 通过设置迁移下线 `consolidatedLayout=false` 与 `appendPolishBlock`，减少维护路径，但曾关闭该选项的用户后续写入会得到不同结构；必须按 §4.5 保留设置，不批量改写旧笔记。② 保留两种布局，涉及笔记结构的修改须覆盖两条路径。导入强制 rewrite 的现有规则不变。

## 15. 笔记版本保存规则

`.versions` 是插件保存的可切换快照，清单和快照通过 Vault adapter 读取，不依赖 Obsidian 文件索引是否返回隐藏路径。它与 Obsidian 文件历史（记录母本的逐次修改）不是同一份版本清单。

- **普通重新整理**（`RepolishService.repolishMarkdownFile`）不改母本正文：先确保原稿快照与 manifest 可读写，再创建派生 Markdown，最后以 `activate:false` 写 `minutes` 缓存。原稿快照验证失败时停止，不创建派生文件。
- **清稿**（`RepolishService.generateCleanScript`）首次生成前先确保原稿快照，再经 `switchVersion` 切换母本；类型为 `clean`，不另存隐藏缓存。
- **版本切换**（`VersionStore.switchVersion`）：缺失或损坏的类型、清单或原稿快照必须在改母本前拒绝；母本写入成功但活动 ID 写入失败属于部分提交，缓存保留且可再次切换。
- **续录**：新音频与逐字稿写入独立暂存；队列凭保存的 `targetPath` 与 `targetSourceId` 和完整 v2 转写账本提交，不根据当前活动笔记改写目标；账本损坏、来源冲突或目标变化时拒绝提交并保留恢复材料。`pre-append` 快照以 `activate:false` 保存。只有目标提交路径写入续录成功标记。
- **转写重试补齐后的自动整理**（`queue-transcribe-retry-flow.ts` 的 `maybeAutoRepolish`）：笔记没有整理正文时原地整理（补缺失的会话键、不覆盖已有键，按 `autoRenameWithTitle` 改名）；否则走普通重新整理。手动「原地重新整理」不补键、不改名。失败记录 `queue.auto_repolish_failed`，已补齐的转写不回滚。
- **首次 AI 整理与后台合并重试**在模型调用前读取完整母本 Markdown，并在重写提交前比较；内容变化时保留当前母本、转写、录音和整理检查点。首次整理与后台重试都将冲突任务标为仅手动重试，不安排自动重试；“Retry all”和启动重试跳过该任务，用户检查母本后可在进度面板单项重试。单项重试按当前母本重新整理，不复用冲突前的已完成整理检查点。追加布局在写入前读取最新 Markdown，再追加整理结果。两种重写都在写入前尝试保存不激活的 `pre-polish` 快照；续录已保存 `pre-append` 快照时，首次整理不重复保存。快照保存失败只记录日志，不单独阻止未冲突的写入。
- 同一插件实例按来源 ID 串行执行 manifest 读改写；不协调 Obsidian 同步或其他插件对同一文件的写入，仅凭磁盘状态无法归因外部修改。
- 删除带衍生版本的笔记：确认后复核派生稿集合与正文，变化时保留文件并要求重新确认。
