# QnALog

[English](README.md) | 简体中文

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/qnalog-lockup-reversed.svg">
    <img src="docs/brand/qnalog-lockup.svg" alt="QnALog" width="298" height="96">
  </picture>
</p>

在 Obsidian 中录制或导入音频、转写，并将对话整理为 Markdown 纪要。QnALog 不内置 API Key，无需 QnALog 账号，使用你自行选择的服务。需要 Obsidian 1.11.4 或更高版本。

[安装](#安装) · [首次配置](#首次配置) · [基本使用](#基本使用) · [功能](#功能) · [文件与目录](#文件与目录) · [隐私与网络](#隐私网络与更新)

## 安装

### 社区插件目录（推荐）

1. 在 Obsidian 中打开「设置 → 第三方插件」，浏览社区插件目录。
2. 搜索 **QnALog**，安装后启用。

### BRAT

1. 从社区插件目录安装并启用 **BRAT**。
2. 在 BRAT 中选择 **Add beta plugin**，填入 `qnalog/qnalog`。
3. 安装后在「设置 → 第三方插件」中启用 **QnALog**。

### 手动安装 Release

从[发布页](https://github.com/qnalog/qnalog/releases)下载 `main.js`、`manifest.json`、`styles.css`、`LICENSE` 和 `NOTICE`，放入 `<知识库>/.obsidian/plugins/qnalog/`。手动安装不会创建安装备份。源码安装和回滚见[源码安装与回滚](#源码安装与回滚)。

## 首次配置

1. 打开「设置 → QnALog」，选择 **Setup Wizard**（配置向导），选择预设，填写所需 API Key 和模型信息，检测服务后选择 **Apply and start**（应用并开始）。
2. 打开「设置 → QnALog → Open sidebar」（打开侧栏）。首次启用且配置不完整时，向导可能自动出现；之后可随时从设置首页重新打开。
3. **Quick config**（快速配置）是独立的预设配置捷径。已有配置时，替换前需要确认。要分别配置服务，请打开「设置 → QnALog → API」。

录音转写需要配置语音转文字（ASR）服务。导入完整音频可以使用单独的转写服务。AI 整理、问一问、资料提取和报告生成需要配置大语言模型（LLM）；只有 ASR 密钥不能使用这些功能。支持的场景也可以使用本地服务。

## 基本使用

1. 点击左侧功能区的 **QnALog 实时纪要面板**打开侧栏。Obsidian 工具栏显示随主题变化的单色 Q 图标。

   <picture>
     <source media="(prefers-color-scheme: dark)" srcset="docs/brand/qnalog-mark-reversed.svg">
     <img src="docs/brand/qnalog-mark.svg" alt="QnALog 面板图标" width="32" height="32">
   </picture>

2. 选择模板和音频输入，并确认音量电平会随声音变化。
3. 开始录音，查看实时大纲，并按需添加标记或现场笔记。
4. 停止录音，在「处理进度」中查看转写、AI 整理和 Markdown 写入状态。处理中断时，可从失败步骤重试。
5. 按需使用「沉淀」和「问一问」页签，或为完成的纪要生成报告。

侧栏有「大纲」「沉淀」「问一问」「纪要」四个页签，分别用于查看实时大纲和标记、审核资料候选项、针对纪要提问，以及浏览纪要列表。「纪要看板」是独立视图，可通过命令或面板按钮打开，不是第五个页签。

1.6.1 的界面会跟随浅色或深色主题，支持窄面板、清晰的键盘焦点提示和减少动态效果偏好。

## 功能

### 大纲与现场标记

录音时逐步生成章节，并链接到对应的录音位置；录音结束后 AI 可以补全大纲。要只重建大纲，可在已完成纪要侧栏选择「根据全部转写重建大纲」。替换大纲详情前，QnALog 会把笔记备份到 `<vault>/<configDir>/qnalog-outline-backups/<timestamp>/<filename>`。生成失败、结果不完整或生成期间笔记发生变化时，不会替换现有笔记。此操作不会改动纪要正文。

录音期间可使用标记：`#术语`（解释术语）、`?问题`（询问当前讨论）、`!重点`（标记重点）、`@负责人`（建议待办负责人）、`/待办`（标记待办候选项）。半角和全角符号都可识别。这些现场笔记会作为明确标注的补充材料进入整理提示，不会冒充转写文本。

### 续录与来源依据

可从当前纪要侧栏、文件菜单或悬浮控件选择「追加录音到此纪要」。QnALog 会核对目标纪要，把新内容录入单独的待合入笔记，并等待目标纪要当前的处理和转写任务完成后再合并。合并失败时，暂存笔记和音频会保留供重试。如果目标被删除或其转写身份变化，单独录音会保留，不会写入其他纪要。续录会累计多段音频，保留各段来源依据并连续编号。

转写纪要会保留语音转文字服务返回的原文和修订历史。决定、行动、问题和议题可以引用具体转写片段；片段变化后，对应引用会标记为过期。证据随已有整理请求返回，不会额外发起提取请求。

<details>
<summary>原文、派生版本与清稿</summary>

首次生成派生版本前，QnALog 会缓存可恢复的原文。快照或索引无法保存或验证时，不会覆盖来源。选择「生成清稿」会创建独立文件，并在来源笔记中激活该版本。普通重新整理会生成派生 Markdown 文件和 `minutes` 缓存，但不会自动激活派生版本。`.versions` 缓存不等同于 Obsidian 文件历史。

</details>

### 长内容、处理进度与恢复

普通会议和学习笔记模式会把长录音分段整理并保存本地检查点，最后按时间顺序组装。如果请求中断或模型达到输出长度上限，已完成部分会复用，未完成部分可以重试。未完成内容会显示为部分完成，不会保存成空纪要。

处理面板区分语音转写、AI 整理和 Markdown 写入，显示当前阶段、失败原因以及重试或取消入口。支持的失败任务可以从失败步骤继续。未知或损坏的队列记录会暂停，并保留原始数据和引用材料；请到待处理队列查看原因。重试不会自动修复暂停的损坏记录。

### 沉淀与资料库

默认由用户发起资料提取。自动提取默认关闭；启用后只会自动写入待办候选项。人员和词汇表候选内容仍需审核或维护。

人员可以保留、合并或忽略。确认后的待办会成为独立卡片；术语可以维护在词汇表中。侧栏可把已确认待办汇总成待办墙，资料项会保留来源链接。候选待办支持行内编辑负责人、截止日期和子任务。

### 纪要列表、看板与交付物

纪要列表可按文件夹或时间组织，并提供搜索和模板筛选。「纪要看板」是用于查看已保存会议资料的独立视图。

HTML 和 PDF 报告会调用已配置的大语言模型根据纪要生成，不会修改原纪要。HTML 和 PDF 可从命令或纪要列表右键菜单中的「生成」入口使用。PDF 生成需要桌面端 Obsidian，过高的整页报告有高度上限；需要完整阅读时可用 HTML。

纪要列表右键菜单的「生成」入口还可创建 `.eml` 邮件草稿。草稿可包含摘要和附件，例如原始 Markdown、生成的 PDF 或已有导出文件；收件人可从人员资料中匹配。请在邮件客户端检查并发送，QnALog 不会自动发送邮件。

### 录音可靠性

- 录音前后可查看音量电平；设置中提供设备检测。
- 输入设备由用户选择。兼容且确认有独立声道的设备可按声道转写；无法确认声道独立时不会启用分离。
- 删除转写记录时，可以选择是否一并删除录音文件。
- 短录音过滤默认开启。普通新录音不足 3 秒会丢弃；3 秒至不足 10 秒只保留音频，也可手动导入。关闭过滤后，短录音按普通流程处理。导入音频不受此过滤影响。续录仍会丢弃不足 3 秒的音频，3 秒至不足 10 秒则正常追加。

## 文件与目录

以下是默认位置，文件和目录按需创建。分段缓存用于临时处理，不是整理纪要的目录。

| 内容 | 默认路径 |
|---|---|
| 录音 | `QnALog/录音` |
| 转写纪要 | `QnALog/转写纪要` |
| 会议资料 | `QnALog/会议资料` |
| 人员 | `QnALog/资料库/人员` |
| 待办卡片 | `QnALog/资料库/待办` |
| 视图 | `QnALog/资料库/视图` |
| 词汇表 | `QnALog/资料库/词汇表.md` |
| 诊断日志 | `QnALog/系统/诊断日志` |
| 归档 | `QnALog/资料库/归档` |
| HTML 报告 | `QnALog/HTML报告` |
| 邮件草稿 | `QnALog/邮件草稿` |
| 分段缓存 | `QnALog/.cache/segments` |

已保存的可配置路径不会因界面语言变化而重设，已有文件也不会自动搬迁。未设置的路径和邮件草稿等计算出的默认位置会根据当前解析的界面语言确定：中文界面使用中文目录名，其他已解析语言使用英文目录名。界面语言默认跟随 Obsidian。邮件草稿位置没有单独设置项；缓存位置也不是可配置的目录设置。

## 平台与音频设置

QnALog 支持 Obsidian 桌面端和移动端。移动端使用设备麦克风录音，可通过分段或整文件 HTTP 请求转写。电脑系统音频、虚拟设备、多声道采集、桌面设备检测和实时 WebSocket 转写需要使用桌面端。

采集电脑音频通常需要虚拟声卡：

- Windows：VB-Cable
- macOS：BlackHole
- Linux：PulseAudio / PipeWire monitor source

使用 VB-Cable 时，会议软件、浏览器和系统输出发送到 **CABLE Input**；QnALog 从作为录音设备的 **CABLE Output** 读取音频。如果还要录制自己，请把麦克风输入选为物理麦克风。设备选择和检测见「设置 → QnALog → Recording」。

## 隐私、网络与更新

QnALog 无需 QnALog 账号，也没有 QnALog 自营后端、广告、行为分析或遥测。设置、队列项目和上下文保存在 `.obsidian/plugins/qnalog/data.json`。当前 API Key 使用 Obsidian SecretStorage；旧数据和安装备份中仍可能残留明文或混淆后的密钥。SecretStorage 在不同安装或同步间的行为没有保证，缺失的密钥需要重新填写。详见 [`PRIVACY.md`](PRIVACY.md) 和 [`SECURITY.md`](SECURITY.md)。

网络请求由所用功能决定：

- 转写会把音频发送给已配置的语音转文字服务。
- 整理、问一问、资料提取和报告生成会把相关文本与提示发送给已配置的大语言模型。手动检测服务和获取模型列表也会联网。
- 只有点击「设置 → 关于 → Check for updates」或在命令面板运行 **Check for Updates** 时，QnALog 才会从本仓库 `main` 分支的 raw GitHub 地址或 jsDelivr 镜像读取 `manifest.json`。没有后台更新检查；QnALog 不下载或安装插件文件，由 Obsidian 或 BRAT 管理安装。

可选的桌面端外部导入功能只读取你选定目录中的音频，将副本放入知识库的 QnALog 缓存，并在插件目录保存导入状态。源文件保持原位。导入音频的转写和整理仍使用你配置的服务。

处理敏感内容时，尽量使用本地服务并在录音前取得同意。发送给第三方服务的内容受该服务提供方条款约束。

## 源码安装与回滚

源码安装面向桌面端。它从仓库源码构建，并在覆盖现有插件目录前留档，包括 `data.json`：

```bash
git clone https://github.com/qnalog/qnalog.git
cd qnalog
npm ci
npm run build
npm run install:vault -- "/你的知识库路径"
```

安装脚本会把 `main.js`、`manifest.json`、`styles.css`、`LICENSE` 和 `NOTICE` 复制到 `<知识库>/.obsidian/plugins/qnalog/`，备份位于 `<知识库>/.obsidian/qnalog-install-backups/<timestamp>/`。社区插件目录和 BRAT 各自管理安装。

设置版本相同时直接读取。可识别的正式版本（版本号从 1 开始）在存在迁移路径时向前迁移并保留用户配置。磁盘版本高于当前版本时保持只读，不会被覆盖。无法识别来源时，先把原文件备份到 `<插件目录>/settings-backups/`，再使用默认值。这不代表所有旧版本都保证可迁移。

恢复安装备份：

```bash
npm run restore:vault -- "<知识库>/.obsidian/qnalog-install-backups/<timestamp>" "/你的知识库路径"
```

`restore:vault` 会在恢复前留存当前插件目录，因此恢复操作也可撤销。脚本会拒绝不安全的插件 id，以及包含链接或相互重叠的还原路径。加 `--set-enabled` 可更新 `community-plugins.json`；否则请在 Obsidian 中切换插件。备份位于知识库之外时，请传入知识库路径。恢复旧构建后，较新的设置可能保持只读；恢复文件不保证恢复另一套安装的 SecretStorage 密钥。

## 项目背景

QnALog 派生自 [LexVoice](https://github.com/Lynn-x/LexVoice)，基于其最后一个 MIT 授权版本（2.1.2），此后独立维护。来源与许可细节见 [`NOTICE`](NOTICE) 和 [`MAINTAINING.md`](MAINTAINING.md)。

QnALog 不继承前身项目的设置，也不迁移其笔记；加载时不会扫描或改写已有笔记。插件 id 为 `qnalog`，与前身项目的 id 不同；写入的数据使用 QnALog 命名空间。

## 参与贡献

开发命令和参与方式见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，维护流程与验证要求见 [`MAINTAINING.md`](MAINTAINING.md)。

## 许可证与致谢

MIT，详见 [`LICENSE`](LICENSE)、[`NOTICE`](NOTICE) 与 [`MAINTAINING.md`](MAINTAINING.md)。

原始代码版权归 Lynnx（2026）；本项目修改版权归 Q&A Log Team（2026）。
