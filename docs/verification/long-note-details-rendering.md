# 长笔记折叠区测量

日期：2026-10-12。环境：Obsidian 1.14.4，Fresh 库，实时预览。首批数据由维护者实测提供。本轮没有可连接的 Obsidian CDP 地址，未重新采样。

## 已有测量

每步向下滚动 500 px，并在两次 `requestAnimationFrame` 后读取视口内的 `.cm-line` 与 `details`。窗口必须保持前台，否则渲染暂停，读数会是 0。

| 变体 | 露出原始机器文本的步数 / 总步数 | `<details>` 首次渲染 |
|---|---:|---|
| 当前旧格式，6 段，数据行合计约 73 kB | 57 / 94 | 滚到末尾 |
| 去掉块内空行 | 57 / 94 | 滚到末尾 |
| 再去掉 `###` 段落标题 | 57 / 94 | 滚到末尾 |
| 数据折为每行 120 字符 | 未渲染 | 滚到底仍未渲染 |
| 数据约 36 kB | — | 未渲染 |
| 数据约 18 kB | — | 滚到末尾 |
| 数据约 7 kB | — | 滚动约 60% |
| 数据移到 `<details>` 外的单行隐藏元素 | 1 / 9 | 立即折叠 |
| 3 段短笔记对照 | 0 / 7 | 立即折叠 |

测量结果显示，渲染延迟随 `<details>` 总字符量变化。空行、标题和数据行换行没有改变延迟。转写完整记录因此放在折叠块之后的隐藏行内元素中；折叠块只保留标记、标题和可读转写文本。

## 按段拆分与 base64 数据

维护者按真实比例重新测得 6 段样本：可见转写文本长度为 274、871、1,806、3,306、3,463、2,145 字符，合计 11,865 字符；来源 JSON 合计约 53,000 字符。上一版 URI 编码的单块笔记为约 260,000 字符，旧注释格式为约 79,000 字符。URI 编码导致数据行膨胀约 4.6 倍。

当前写入器把每段可读转写放在独立 `<details>` 中。单块内部限制为 3,500 字符；超过限制的段落按句子边界拆分。完整来源 JSON 使用 UTF-8 base64 隐藏元素，并在一个连续行中写入。base64 的文本膨胀率约为 4/3，低于 URI 编码；单测检查编码行总长不超过解码 JSON 的两倍。

| 格式 | `<details>` 组织 | 转写 JSON | 整篇文件字符数 | Obsidian 首次渲染数据 |
|---|---|---:|---:|---|
| 旧格式 | 一个长 `<details>` | 块内 JSON 注释 | 约 79,000 | 评审方：第 92/95 步才折叠，81/95 步露出原始文本 |
| 上一版 | 一个长 `<details>` | URI 编码隐藏元素 | 约 260,000 | 评审方：第 14/18 步才折叠，7/18 步露出原始文本 |
| 本版写入器夹具 | 每段一个或多个 `<details>` | UTF-8 base64 隐藏元素 | 73,186 | 未在 Obsidian 实测 |

本轮脚本离线生成的样本包含 65,398 个未压缩来源 JSON 字符、57,272 个 base64 数据字符、11,865 个可见转写字符。各转写块内部长度为 610、1,207、2,142、3,215、775、3,215、932、2,481 字符；长段被按句子拆分。上一版单块夹具内部长度为 12,722 字符，整篇 URI 编码夹具为 557,136 字符。新夹具整篇长度为旧格式实测值 79,000 字符的 0.93 倍。样本中的原始 JSON 比评审方给出的 53,000 字符多 12,398 字符。

评审方的块内字符阈值测量显示，2,000 与 4,000 字符块立即折叠，6,000 字符块从第 4 步开始折叠，9,000 与 13,500 字符块在后续滚动中才折叠。设计上每块使用 3,500 字符上限，为测量到的 4,000 字符立即折叠边界留出余量。该上限由单元测试断言。

## 本轮新增的测量脚本

运行 `node scripts/measure-note-details-rendering.mjs --vault=/path/to/Fresh --cdp=ws://127.0.0.1:PORT/devtools/page/ID`。脚本通过插件当前 `serializeTranscriptBlock` 与 `buildTextImportSourceDetails` 生成真实比例的 6 段长笔记和 3 段短笔记，构造上一版单块 URI 数据布局与本版拆分 base64 布局。每篇样本还含当前写入器生成的「录音中实时大纲（草稿）」折叠块；脚本输出来源覆盖记录字符数、每个转写 `<details>` 内部字符数和笔记文件字节数。脚本用 Obsidian URI 冷开每篇笔记，通过 CDP 每步发送 500 px 鼠标滚轮事件，并输出每步的 details 数、open 数、可见机器注释行数、可见 `### 段落` 行数和 `scrollHeight`。结束时删除临时笔记。

本机 `obsidian help` 返回“CLI is unable to find Obsidian”，当前窗口没有可用的 CDP 地址。本轮用无效的本地 CDP 地址检查了夹具生成和清理，未进行 Obsidian 冷打开或滚动测量。评审方提供的渲染数据与本轮离线夹具数据分开记录。脚本运行时需要 Obsidian 保持前台；维护者仍需在 Fresh 库运行一次脚本，检查首次折叠和滚动位置结果。

## 读取兼容

| 文件布局 | `readTranscriptBlocks` 读取方式 | 正常重写后的格式 |
|---|---|---|
| 旧式 `qnalog-transcript-data` 注释 | 直接解析 v2 JSON | UTF-8 base64 隐藏元素 |
| 上一版 URI 编码隐藏元素 | base64 解码失败时 URI 解码 | UTF-8 base64 隐藏元素 |
| 本版 base64 隐藏元素 | base64 解码，并展开 `textReferences` | UTF-8 base64 隐藏元素 |
| 新旧数据同时存在 | 优先读取隐藏元素；旧注释作为兼容输入 | 删除旧数据，保留一份隐藏元素 |

统一读写模块为 `src/transcript/transcript-markdown.ts`。重写与迁移入口在 `src/notes/note-transcript-ledger.ts`；调用方包括 `src/notes/text-correction.ts`、`src/notes/continuation-commit-flow.ts`、`src/notes/session-finalize-sources.ts`、`src/notes/note-polish-flow.ts`、`src/queue/queue-transcribe-retry-flow.ts`、`src/imports/import-service.ts`、`src/imports/transcript-checkpoint.ts`、`src/notes/live-segment-flow.ts`、`src/notes/audio-time-link-service.ts` 和 `src/indexing/note-index.ts`。这些调用方通过统一解析器处理三种格式。
