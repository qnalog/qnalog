# QnALog 功能架构

按层次说明各模块的功能、数据流、状态与失败处理。只描述系统做什么，不描述代码结构。
技术约束与流程见 `MAINTAINING.md`；UI 视觉基准见 `DESIGN_SPEC.md`。行号对应当前源码。

---

## 0. 整体链路

```
音频 → 带时间偏移的分段文本 → 结构化笔记 → 知识对象 → 交付物
```

采集阶段产出的单位是「带时间偏移的分段文本」，不是连续文本。笔记的生成分两步：录音期间增量维护大纲，
停止录音后按分段生成正文。笔记完成后可提取人员、待办、学习卡片、热词四类对象；
导出阶段把同一份笔记输出为报告、邮件草稿、看板或 Canvas。

## 1. 链路概览

1. **采集**：两个录音器并行工作。一个按固定时长切片（默认 5 分钟），一个录整场作为完整音频。
   每个切片写入缓存文件，同时登记为一条可持久化的转写任务；插件异常退出后由该任务恢复。
2. **转写**：每个切片单独发送到用户配置的转写服务，返回带时间偏移的文本。
   是否支持说话人分离、多声道、流式由服务能力判定，不使用固定服务名单。
3. **实时大纲**：录音期间，后台将尚未纳入大纲的转写段增量发送给模型，得到带时间锚的章节列表。
   已有章节的标题与时间锚不再修改，新内容只追加到末尾。
4. **纪要**：停止录音后，全部转写按时间划分为若干窗口（下称「分部」），每个分部单独调用模型整理，
   完成一个即写入对应的断点文件。全部分部完成后，正文由程序按时间顺序拼装，不调用模型重写全文。
   因此长会议不会因单次调用失败而丢失全部结果，只缺少未完成的分部。
5. **落盘**：笔记结构固定，见 §2。原始转写不删除。
6. **沉淀**：从笔记提取四类候选（人员、待办、学习卡片、热词），用户逐类确认，
   确认后写入库中对应的对象文件。被忽略的候选会记录，不再重复提示。
7. **交付**：笔记可生成 HTML 报告（通用模板与固定模板两种）、整页 PDF、`.eml` 邮件草稿；
   另有按文件夹分组的看板、语义 Canvas、卡片墙与对象总览。

---

## 2. 数据主干

| 概念 | 内容 | 生命周期 | 依据 |
|---|---|---|---|
| `RecordingSession` | 一次录音会话：模式、分段列表、上下文、音频路径、实时大纲状态、重试与熔断状态 | 内存态，插件重启后丢失（可恢复任务已单独持久化） | `src/shared/types.ts:298`、`src/audio/recording-service.ts` |
| `Segment` | 一个音频切片及其转写文本、时间偏移、说话人、来源标记 | 录音过程中写入笔记；是发送给模型的输入单位 | `src/shared/types.ts`（`Segment`） |
| `QueueTask` | 可持久化任务，类型为 `transcribe` / `merge` / `generate-prompt` | 存入 `data.json`，重启后继续处理 | `src/queue/task-queue.ts:142`、`src/shared/settings-io.ts:568` |
| `BriefingCheckpoint` | 长纪要的分部进度：源哈希、选项哈希、每部状态与产出 | 存于 `配置目录/plugins/qnalog/briefing-checkpoints/<jobId>.json` | `src/briefing/checkpoint-store.ts:18`、`src/briefing/pipeline.ts:516` |
| 笔记文件 `.md` | 主产物：正文 + 逐字稿 + 隐藏数据块 | 永久 | `src/notes/note-writer.ts:92`（`rewriteConsolidated`）/ `:177`（`appendPolishBlock`） |
| 对象文件 | 人员档案 / 待办卡 / 学习卡 / 词汇表 / Base 视图 / 报告 | 永久 | `src/sediment/index.ts`、`src/people/index.ts`、`src/views/wall-markdown.ts` |
| `TaskActivity` | 界面展示用的任务状态：阶段、进度、错误分类、可执行动作 | 内存 + 事件流 | `src/shared/task-activity.ts:1` |

约束：`Segment` 是链路上复用的原始材料单位。恢复逻辑都依赖笔记中保留的原始转写，失败时重跑未完成的步骤，不重做全部。

**笔记结构（顺序固定）**：由 `rewriteConsolidated` 生成（`src/notes/note-writer.ts:92`），
`appendPolishBlock`（`src/notes/note-writer.ts:177`）是另一种追加式实现。

```
frontmatter（mode / time / 时长 / 人物 / 状态 / tags）
# 2026-09-13 14:30 · 综合纪要
整合版正文（模型产出的正文）
---
## 原始材料
  录音信息 / 外部音频来源 / 文本来源
  会中补充材料
  <details> 录音中实时大纲 </details>
  <details> 回听时间轴 </details>
  <details> 原始音频（N 段） </details>
  <details> 分段原始转写（N 段，每段带时间与音频锚点） </details>
<!-- lexvoice-session:<id> -->
<!-- 沉淀候选与决策日志（HTML 注释，阅读视图不显示） -->
```

正文在上、原始材料在下。`rewriteConsolidated` 与 `appendPolishBlock` 是两种写入方式，由 `consolidatedLayout`
（默认开）选择：开启时重写整篇以维持上述结构；关闭时只在文件末尾追加整合版块（用于兼容历史笔记）。
分段逐字稿由 `<!-- lexvoice-segments-start:<id> -->` / `...-end:...` 标记界定，
录音期间产生的临时内容（面试提纲等）插入在 start 之前（`insertBeforeSegmentsStart`，`src/notes/note-writer.ts:257`），
续录与重新整理都不会改变已有内容的相对位置。

---

## 3. 分层结构

```
L6 交付     HTML 报告 · 整页 PDF · .eml 邮件草稿 · 纪要看板 · 语义 Canvas · 卡片墙/对象总览
L5 沉淀     人员 · 待办 · 学习卡 · 热词
L4 落盘     笔记结构 · 笔记索引 · 版本块 · 当日日记概要
L3 理解     实时大纲（增量更新） · 纪要流水线（分部 + 断点 + 程序拼接）
L2 转写     服务条目与协议 · 切片/整文件/流式三种形态 · 说话人识别 · 多声道分离
L1 采集     双录音器切片 · 设备与声道模式 · 电平表 · 静音判定 · 缓存与外部收件箱
横切        配置与迁移 · 任务状态与队列 · 诊断与脱敏 · 更新检查 · 主线隔离
```

---

## 4. 逐层功能说明

### 4.1 采集层

**双录音器**（`src/audio/recorder-service.ts`）：分段录音器按 `segmentIntervalMinutes`（默认 5）切片，
`masterRecorder` 同时录制整场。
`cutSegment()`（`src/audio/recorder-service.ts:515`）停止当前录音器、启动新的录音器，并把切片交给 `onSegment` 回调。
`_awaitRecorderStop` 设 4 秒超时：虚拟声卡或远程设备断开导致 `onstop` 不触发时，用已收到的 chunk 结束本次切片，
避免录音状态一直停留在「录音中」。

**失败处理**：切片重启失败时，状态置为 `paused`，暂停 masterRecorder，
提示「停止录音以保存完整音频后重试」，不会保持「录音中」状态。切片锁在 `finally` 中释放，异常不会导致后续切片被跳过。

**采集模式**：`captureMode` 取 `mic` / `mix-virtual` / `virtualCable`；
`audioChannelMode` 取 `auto` / `mono` / `multichannel`。

**设备选择不做自动判断**：`selectedVirtualDevice` 为空时拒绝开始录音，要求用户先选择；
`selectedMicrophoneDevice` 为空时使用系统默认输入，已选设备不可用时直接报错，不回退到其他设备
（`shared/defaults.ts` 注释、`settings-tab.ts:400` 附近）。该规则的来源是：曾出现设备识别错误导致整场录音写入虚拟声卡。

**静音与短录音**：整场电平接近零（≥30 帧中「有声帧」占比 < 2%）时提示检查音频设备；
时长 < 3 秒的录音直接丢弃并告知（`_finalizeSessionImpl` 顶部，`src/notes/session-finalize-service.ts:606`）。两种情况下都只提示，不自动更换设备。

**缓存与写入顺序**：切片写入 `segmentCacheFolder`（默认 `LexVoice/.cache/segments`），`keepSegmentAudioFiles` 默认 false。
写入缓存先于登记任务执行，插件异常退出后可按路径恢复（`queueLiveSegmentPersistence`，`src/audio/recording-service.ts:844`）。

**外部收件箱**（`audio/external-inbox.ts`）：监听库外的绝对路径（例如云盘同步目录）。
指纹由路径、大小、mtime 组成，记入 ledger，用于去重、限制重试次数与定期清理。
稳定延迟 `inboxStabilizeDelayMs` 默认 3000ms，取 0 表示立即处理。
处理完成后文件移入 `processed` 子目录。同步冲突文件跳过并提示。移动端不启用（`src/audio/external-inbox-service.ts:107`）。

### 4.2 转写层

服务配置分两层：内置服务条目与协议。内置 11 个条目（SiliconFlow / OpenAI / OpenAI 说话人分离 / APIMiMo /
OpenAI Realtime / Realtime 翻译 / 百炼 Paraformer Realtime / 百炼 Fun-ASR / 本地 / WhisperX / 自定义），
每个条目带 `protocol` 字段，请求构造按协议分支（`shared/defaults.ts:58` 起、`asr/clients.ts`）。

三种传输形态：

| 形态 | 用于 | 特征 |
|---|---|---|
| 切片上传（同步 HTTP） | 实时录音的每个切片 | 成本低，可并发；段与段的说话人编号不保证一致 |
| 流式（WebSocket） | Realtime 类服务 | 录音过程中持续返回文本；分段设置对该形态不生效（设置页有说明） |
| 整文件异步 | 导入已有音频 | 一次转写全场；说话人编号在全场范围内一致 |

**能力判定方式**（`asr/diarization.ts`）：`isSpeakerDiarizationProvider` 按协议与模型名判断，
`isImportCapableTranscribeProvider` 按服务本身能力判断。源码注释说明了原因：若改为硬编码服务 id 名单，
用户自定义的服务会被设置页改写。

**说话人标签归一**（`asr/speaker-labels.ts`）：两种来源（结构化 `segments[].speaker`、文本内联 `[SPEAKER_00]`）
统一为 `[说话人N]`；同一说话人的连续段落合并为一轮。跨段编号不保证指向同一人，这是分段转写的固有限制，
只有整文件导入能保证全场编号一致（源码注释有说明）。

**多声道分离**（`asr/channel-transcription.ts`）：先用 `analyzeAudioBufferChannels`
（逐帧 RMS、峰值、左右声道相关性）验证声道确实独立，再按同一声道内的连续能量段切出该人的发言分别送 ASR。
最后 `deduplicateOverlappingSpeakerParts` 用文本 bigram Dice 相似度与时间重叠剔除串扰重复；
判定主声道时要求相对音量差 ≥25%，否则按文本长度与声道序号决定。
同一声道相邻段间隔超过 20 秒不合并（`SPEAKER_SPAN_MERGE_MAX_GAP_MS`），任务配额按时长放大（每分钟 3 段）。
无法验证声道独立时不启用分离。声道数上限 4，默认 2（`audio/channel-speakers.ts`）。

**失败处理**：

- 退避分档（`pickAsrRetryDelayMs`，`asr/transcribe.ts`）：服务端 `Retry-After` > 限流（429）30–45s >
  网络与 5xx 从 5s 起指数增长 > 空结果 1.2–2s。限流使用较长退避的原因：短退避会立即再次触发限流，消耗一次重试机会。
- 网络类失败不计入重试次数（`getNextAsrTaskRetryCount`），不把服务故障记在单个音频切片上。
- 熔断（`asr/live-segment-policy.ts`）：连续 3 次瞬时失败后进入 5 分钟冷却，按指数增长至 30 分钟上限；
  积压 10 分钟告警、30 分钟严重；熔断期间批量处理暂停，冷却结束后从持久化队列继续（`processAll`，`src/queue/task-queue.ts:142`）。
- 配额限制：APIMiMo 按账户 10K TPM 计算请求间隔（每音频秒 160ms，上限 45s），切片长度 2 分钟，
  原因是 3 分钟密集中文转写的输出会超过该模型 2K 输出上限而被截断（`asr/transcribe.ts` 常量与注释）。

### 4.3 理解层之一：实时大纲

**内容**：录音期间逐步生成的章节列表，每个一级条目带 `[[文件|HH:MM]]` 时间锚，点击后跳转到音频对应位置。
停止录音后由模型补全为完整章节。

**调度**（`outline-coordinator.ts`）：防抖 `realtimeOutlineDebounceMs`（默认 2500ms，读取点设有下限）、
四种状态 `idle/scheduled/running/backoff`、同一会话内串行执行（`runInOutlineSessionTail`）、失败退避。
在模型请求队列中优先级为 2（后台）；等待超过 15 秒时可提前到普通任务之前，但始终排在用户交互任务之后
（`llm/request-queue.ts` 的 `pump`）。

**增量与稳定性**（`outline-text.ts`）：

- 取最早的未提交段加一个只读回看窗口；`commitThroughCount` 只包含本批实际纳入的段，
  受限窗口不会跳过更早的积压段并将其标记为已处理。
- `mergeStableRealtimeOutlineNodes`：同锚点节点的 `title` 与 `anchor` 保留已有值，`children` 做单调并集
  （只增加不删除，按归一键去重）。源码注释说明该方案的代价：某轮写入的内容错误的子要点不会被后续轮次删除，
  但影响范围限于子项，因此采用此方案。
- 模型把多个条目排在一行时，`normalizeRealtimeOutlineList` 按时间锚切分并重建父子结构，不依赖模型输出换行。
- 时间锚由程序生成，不作为模型输出契约的一部分：模型漏给、复制或编造时间戳时，
  `repairRealtimeOutlineAnchors` 按标题恢复历史锚点。
- `validateRealtimeOutlineMarkdown` 有五种拒收条件（内容为空、无一级条目、一级条目过多、时间锚全部丢失、编号内联在标题中），
  拒收时保留上一版。

该模块集中了全部「把模型输出的 Markdown 归一为固定结构」的逻辑，历史缺陷多发生在此。

**人物指认的低证据检测**：`findLowEvidenceEntities` 找出模型输出中反复引用、但原始转写中很少出现的具名实体。
源码注释说明这只是提示用户核对，不自动删除或修改（转写错字会使真实人名计数偏低）。

### 4.4 理解层之二：纪要流水线

长录音的处理前提是单次模型输出不可靠，因此按时间窗口分割并为每个窗口保存中间结果
（`src/briefing/pipeline.ts`、`src/briefing/merge-pipeline.ts:116` / `:539`）。

**流程**：

1. **预压缩**：文本导入且内容过长时先分段摘要（`maybePreSummarizeTextImportForMerge`，`src/notes/note-markdown.ts:1365`），
   并在纪要顶部说明结果基于摘要稿。
2. **作业标识**：`createBriefingJobId(segments, mode, model, optionsKey)` 生成 `id`、`sourceHash`、`optionsHash`。
   更换模型或修改选项会生成新作业，不使用旧断点。
3. **分部规划**：`planBriefingParts` 按目标字符数（默认 24000，由保真策略调整）在边界处划分；
   单个超长段先经 `expandOversizedBriefingSegments` 拆分。
4. **主题图**：`buildProgrammaticTopicMap` 由程序按时间线生成，不调用模型，作为各部分共用的坐标。
5. **逐部整理**：每个分部调用一次流式请求（`thinkingMode: fast`，`max_tokens` 按字符数估算），
   解析结果后做两项评估：`assessBriefingPartFidelity`（产出字数与目标字数的比值，判断是否过简）与
   `assessBriefingPartGrounding`（原文锚点覆盖率，判断是否遗漏信息）。
   首版结果可用时先写入断点，再做质量修复。源码注释说明原因：首版是已计费结果，也是恢复边界，
   不能因为后续修复请求超时而丢失。
6. **补细节**：评估判定过简或遗漏时，再发送一次「对照原文补回信息」请求，
   按 `产出字数 + 命中锚点×120` 打分，只有分数更高才替换；补细节失败则保留首版。不做重复重试。
7. **拼接**：`assembleBriefingParts` 由程序按时间顺序拼装，不重写整篇正文。
   `synthesis` 在分部数大于 1 时额外调用一次全局统一成文，避免各窗口被写成互不相关的会议。
8. **断点复用**：`reconcileBriefingCheckpoint` 只处理未完成的分部；断点文件先写 `.tmp` 再改名，写入是原子的。
9. **收尾处理**：`postProcessBriefingOutput`（`src/notes/note-markdown.ts:1193`）按顺序执行：剥离模型输出中的机器块
   （人员、素质、标签注释）→ 归一 callout → 按当前模式的 schema 过滤 frontmatter 字段 →
   强制覆盖 `mode`、`time`、`状态` → 合并 tags（`lexvoice/<mode>` + 已有 + 模型建议；`人物/x` 转为 `人物` 属性）→
   结果被截断时在正文前插入告警（`BRIEFING_TRUNCATION_WARNING`）。

**其他相关机制**：

- 输出预算：`getBriefingMergeMaxTokens` 按录音长度分档（4096 / 8192 / 16000 / 48000，`llm/config.ts`）；
  服务端明确拒绝该预算时按 `[384000, 256000, 192000, 128000, 64000, 32000, 16000, 8192, 4096]` 逐级降低，
  只依据服务端拒绝，不依据模型名预设。
- 截断续写：`callLlmWithContinuation` 以「assistant 预填 + 从断点继续」的方式补全被截断的输出，并去除拼接处的重叠。
- 上下文超限作为独立错误类别处理：重发同一份超长 prompt 会重复失败并重复计费，因此在首次收到超限后切换为分段处理。
- 整理失败时写入的不是空笔记，而是标记为「部分完成」的结果（`BriefingPipelineIncompleteError`），原始逐字稿保留。

### 4.5 落盘层

一次会话的主产物是一篇 Markdown 文件，其余文件（对象、报告、Canvas、索引）都由它派生。结构见 §2。

- **两种写入方式**（`consolidatedLayout`，默认开）：开启时由 `rewriteConsolidated` 重写整篇，维持正文在上、
  原始材料在下的结构；关闭时由 `appendPolishBlock` 只在文件末尾追加整合版块，用于兼容历史笔记。
  读取端需要同时识别两种形态（源码中多处「旧实现只识别 `## 📁 原始材料`」的注释与此相关）。
- **按标记插入**：分段逐字稿由 `<!-- lexvoice-segments-start:<sessionId> -->` / `...-end:...` 界定，
  面试提纲等内容插入在 start 之前（`insertBeforeSegmentsStart`，`src/notes/note-writer.ts:257`），会后材料由
`insertBeforeSegmentsEnd`（同文件 `:270`）插入在 end 之前。
  标记包含会话 id，续录与重新整理不会改变已有内容的位置。
- **写入串行化**：每个会话有 `writeQueue` 与 `segmentPersistQueue`，写笔记的操作按顺序执行，
  避免并发写入同一文件相互覆盖（`types.ts:RecordingSession`）。
- **frontmatter 由程序生成**：`postProcessBriefingOutput` 中做字段白名单过滤与强制覆盖，
  并保证 `time` 字段有三条兜底路径不为空（为空会导致「重整」入口无法使用）。
- **版本块**：笔记可保留上一版纪要，由 `<!-- lexvoice-active-version-start/end -->` 界定
  （`version-content.ts`、`indexing/note-index.ts:5`）。「重新整理」与「重新整理为…」写入新版本块，
  不改动原始材料；母笔记与生成版本可以互相切换。
- **笔记索引**：收尾或切换版本后，从正文生成「主题 + 摘要 + 源修订」卡片写回笔记
  （`buildQnALogNoteIndex` → `upsertQnALogNoteIndex`，`src/notes/note-index-service.ts:32`），并解析出对应的 Canvas 路径。
  当前源码中没有读取方：侧边栏的成品面板使用 `extractQnALogNotePanelData`（`src/notes/detail-blocks.ts:125`，
  读取全文并从 `<details>` 中提取小标题），`readQnALogNoteIndex` 只被测试调用。该索引目前只写不读。
- **当日日记**：`appendDailyMeetingOverview`（`src/notes/note-index-service.ts:71`）按模板把「今日会议概要」写入当日日记
  （标题与模板可配置），按 session id 定位条目，重复执行不会产生重复内容。

### 4.6 沉淀层

**四类候选**（`shared/catalog-sediment.ts`）：`person`（人员，逐个判定）→ `todo`（待办，复选框，默认全选）→
`card`（学习卡，同）→ `hotword`（热词，同）。顺序由 `SEDIMENT_GROUP_ORDER` 固定。
侧边栏顶部有四段进度控件显示当前所处阶段，用户可中途停止并回到任一步。

**候选的存储位置**：笔记中的 `LEXVOICE_SEDIMENT_BEGIN/END` 注释块，以及侧边栏的 bucket
（`doneGroups` / `selectedByGroup` / `decisionLog`）。关闭侧边栏后重新打开可以继续处理。

**提交后写入的内容**：

| 组 | 落点 | 行为 |
|---|---|---|
| 人员 | 人员库（`lexvoice/person` 标签），可生成同名 Base 视图 | 合并同名与别名；新笔记链接到已有档案 |
| 待办 | `LexVoice/资料库/待办`（`lexvoice/todo-card`），并写入当日日记 | 使用标准 Markdown task 语法；删除与重做保留来源信息 |
| 学习卡 | `LexVoice/资料库/学习卡片`（`lexvoice/learning-card`） | 与概念卡共同构成卡片墙 |
| 热词 | 词汇表 `LexVoice/资料库/词汇表.md` | 同时将笔记正文中的旧写法替换为新写法 |

**撤销**：每次提交前保存快照（bucket、写入条目、词汇表与正文全文），`restoreSedimentUndo` 可整体回退；
提交成功后的提示条包含撤销入口。

**重复提示的抑制**：

- 稳定 ID（`makeSedimentStableId` 系列）与决策日志：同一候选不会被重复提示。
- `peopleSuggestionIgnores` 与 `peopleSuggestionCache`（上限 500）：已忽略的人员不再出现。
- `knowledgeExtractionHistory`（按文件 mtime 与 size 记录）：未修改的笔记不重复扫描，避免重复计费。

**人员上下文的隐私分档**（`peopleContextMode`）：`privacy`（默认，只提供结构信息）/ `hotwords`
（把姓名作为热词，需要显式同意，记录在 `peopleHotwordsConsentAt`）/ `localFull`（完整档案，仅本地模型）。
该设置决定人名是否会发送到云端。

### 4.7 交付层

| 交付物 | 机制 | 落点 |
|---|---|---|
| 通用 HTML 报告 | 模型产出 JSON 数据，本地模板渲染 | `LexVoice/HTML报告/<笔记名>-HTML报告.html` |
| 研讨 HTML 报告 | 固定模板引擎，模型只产出 DATA JSON 并注入；生成前选择配色，整篇用 `hue-rotate` 改色 | 同上；模板见 `report-templates.ts` |
| 整页 PDF | Electron 隐藏窗口测量内容实际尺寸，注入整页 `@page`，`printToPDF` 生成单页长图（上限 18000px，超出时提示改用 HTML） | `LexVoice/HTML报告/<笔记名>-报告.pdf` |
| `.eml` 邮件草稿 | 从笔记解析收件人，生成正文，附上 MD、PDF 与已生成的导出物 | `LexVoice/邮件草稿/<笔记名>-邮件草稿.eml`（`src/delivery/delivery-service.ts:207`、`src/notes/note-markdown.ts:390`） |
| 纪要看板 | 按文件夹或类型分列，拖动条目即修改文件所属文件夹 | `ui/minutes-kanban-view.ts` |
| 语义 Canvas | 从笔记的实时大纲与正文提取语义图（层级、并列、时序、因果、对比）；节点 ID 使用稳定哈希并带布局版本标记，支持增量重排 | `canvas/semantic-outline-canvas.ts` |
| 卡片墙 / 对象总览 | 打开对应的 Base 视图文件 | `src/views/library-view-service.ts:30`、`src/views/wall-markdown.ts` |
| 问一问 | 以纪要正文与原始转写为上下文回答，原始转写优先；回答可写入笔记的「问一问」小节，并可继续生成 3 个追问 | `src/ui/outline-view.ts:755` |

固定模板的作用：模型只提供数据，版式、分页与防孤行由模板决定；提示词禁止模型写入 `style` 或颜色值，
否则使用色相旋转改色时颜色会不一致。改色由 `recolorReportHtml` 一次覆盖 hex、rgba 与渐变。

### 4.8 场景模式

模式决定 frontmatter 字段与提示词。`shared/catalog-modes.ts` 定义 8 个模式（其中一个为兼容旧笔记保留），
每个模式包含 frontmatter 内容 schema、提示词正文（`prompts/mode-bodies.ts`），并支持自定义模板
（`promptTemplates` 与 `activeTemplateByMode`）。

- **综合纪要 `synthesis`**（默认）：先提炼贯穿全场的主线，再按速览、正文与查阅资料三层整理。
- **工作纪要 `meeting`**：决议、待办、风险与进展同步。
- **访谈 `interview`**：问答转洞察。
- **个人笔记 `monologue`**：口述、灵感与复盘。
- **学习笔记 `learning`**：课程、讲座与播客。
- **研讨会 `seminar`**：观点、争议、证据与悬而未决的问题。
- **圆桌讨论 `huddle`**（`legacy`）：保留以兼容旧笔记，新建录音引导改用工作纪要。
- **关闭 `off`**：只转写、不整理。

**已裁剪的场景**：招聘评估、招聘需求挖掘、晋升评审及其专属设施（JD 库、候选人看板、招聘主页、
简历脱敏、画像覆盖扫描、追问卡）于 2026-09-14 移除，原因与兼容规则见 `MAINTAINING.md` §7。
读旧笔记时未知 mode 按「识别不出模式」安全降级，不抛错。

### 4.9 配置与迁移

**存储结构**：`data.json` 按领域分组（`storage / noteNaming / capture / speech / composer / presentation /
vocabulary / views / liveOutline / dailyNote / retryPolicy / diagnostics / ui / updates`），
`schemaVersion = 5`（`shared/settings-io.ts`）。招聘 / 晋升分组在版本 5 移除，旧 `data.json` 里的
`recruiting` / `promotionReview` 不再读回，首次加载由迁移报告告知。

**重建式白名单**：写回由 `serializePluginSettings` 执行，它返回一个全新对象，
未在其中登记的设置键会在下一次保存时被丢弃。源码在 `settings-io.ts` 的 `sedimentAutoExtract` 处
有对应注释（记为「白名单脚枪第三例」）。因此新增设置键必须同时登记到 normalize 与 serialize。

**迁移报告**（`shared/settings-migration-report.ts`）：加载时对比磁盘上的分组与本次写回的分组，
输出迁移方向（升级、降级、一致）、被丢弃的分组、保留的分组，以及用户需要处理的事项。
通知只显示摘要，明细写入诊断日志。已知分组的丢弃后果有专门文案（例如旧 `services` 分组）。
版本回退后设置项消失的情况会给出上述报告。

### 4.10 任务状态、队列、诊断、更新

- **任务状态模型**（`shared/task-activity.ts`）：状态 `queued/running/waiting/slow/stalled/retrying/failed/cancelled/done`；
  错误分类 `configuration/authentication/rate-limit/timeout/network/empty-result/missing-input/cancelled/internal`；
  另含事件流与可执行动作。界面进度以该模型为数据来源，与队列任务相互对应。
- **队列**（`src/queue/task-queue.ts:142`）：三类任务，七种状态（`pending/running/processing/live/failed/missing/blocked`）。
  `blocked` 表示不可重试的配置或鉴权类失败，不再消耗重试次数；`missing` 表示音频文件不存在。
  每条任务有在途锁，避免队列面板、手动重试与启动自动重试三个入口并发处理同一段音频导致重复计费。
- **诊断**：本地日志（默认开启）、脱敏（`redactDiagnosticText`）、一键复制诊断报告。
  密钥处理在 `shared/util-key-diag.ts`（混淆盐常量不可修改，见 `MAINTAINING.md §3`）。
- **更新检查**（`update-service.ts` / `update-source.ts`）：只读取远端 `manifest.json` 进行版本比对，
  间隔 24 小时，启动后延迟 4 秒执行，不下载也不写入任何文件。
  更新源通过 `isTrustedUpdateSourceUrl` 校验，并有测试覆盖。

---

## 5. 三条端到端流程

**A. 录音**

选择模式 → 开始录音 → 两个录音器启动，电平表用于确认设备工作正常 →
每 5 分钟切出一个切片，写入缓存并登记任务，随后发送到 ASR → 后台每 2.5 秒增量更新大纲 →
停止录音 → 收尾切片 → 依次判断短录音过滤、整场静音、无有效转写 →
确认说话人姓名 → 逐分部整理（每部完成后写入断点，过简或遗漏时补一次）→ 程序按时间拼装正文 →
写入笔记（frontmatter、正文、录音信息、时间轴、逐字稿）→ 写入当日日记概要 → 打开笔记。

**B. 导入音频或文本**

音频：使用整文件异步服务（可启用说话人分离），上传全场 → 轮询 → 一次获得全场一致的说话人编号 →
之后与 A 的后半段流程相同（差别是不写回听时间轴、不保留本地音频）。
也可由外部收件箱触发（指纹去重、稳定延迟、处理后归档）。
文本：跳过 ASR，长文本先做预压缩，正文顶部告知结果基于摘要稿。

**C. 会后从笔记提取知识**

打开笔记 → 进入沉淀页 → 依次处理人员、待办、学习卡片、热词（可中断，候选存放在笔记中）→
提交时写入对象文件，热词同时修改正文中的写法，可撤销 → 打开卡片墙、对象总览或看板复用 →
对外分享时生成 HTML 或 PDF 报告、`.eml` 邮件草稿 → 需要追问时使用「问一问」（原始转写优先，回答可写回笔记）。

---

## 6. 设计约束

1. 原始转写不删除。任何模型环节失败时保留原料，结果是「部分完成」而非空笔记。
2. 长内容按分部处理并保存断点，正文由程序拼接，不依赖单次模型调用输出全文。
3. 时间锚、主题图、拼接顺序、frontmatter 由程序生成；模型只提供内容。
   大纲中已有节点的标题与时间锚在录音结束后不再变更。
4. 服务能力按协议与模型判定，不使用固定服务 id 名单，避免自定义服务配置被改写。
5. 设置写回是重建式白名单，未登记的键等同于不存在；迁移需给出丢弃与保留的分组对照。
6. 失败按类别处理：配置或鉴权错误直接置为 `blocked`；网络与限流不计入重试次数并暂停批量；
   上下文超限时切换为分段处理；输出截断时续写并在正文前插入告警。
7. 插件不执行自我更新，只提示版本，安装由 Obsidian 或 BRAT 完成（见 `MAINTAINING.md §3`）。

---

## 7. 现状缺口与风险

| 项 | 事实 | 影响 |
|---|---|---|
| README 与实现不符（已处理） | `README.md:73,91`、`README.zh-CN.md:86,105` 曾称可导出「HTML 幻灯片」与「可编辑 `.pptx`」，源码中没有对应实现。分支 `docs/purge-slide-pptx-claims` 曾删除这两处说明、`THIRD_PARTY_NOTICES.md` 的 Huashu Design / Guizang PPT Skill 归属说明、`report/render.ts` 中无调用方的 `normalizeSlideVisualItems` 与 `normalizeSlideTodos`，以及附件白名单（只有 html/htm/pdf）之外的 `ppt`/`pptx` MIME 分支 | 对外说明与已实现的导出（HTML 报告、PDF 报告、`.eml` 邮件草稿）一致 |
| 类型检查盲区 | 47 个文件带 `@ts-nocheck`；`tsconfig.strict-core.json` 只覆盖 14 个文件 | 漏引用只能靠 `npm run check:undefined-symbols` 检出 |
| 主控文件体积 | `src/main.ts` 已从 24,679 行降到 513 行，域逻辑与状态在 26 个域服务里；拆分均为「纯搬迁、零行为改动」 | 跨链路改动的落点已可控 |
| UI 文件体积 | `src/ui/outline-view.ts` 6,468 行 / 211 个方法、`src/ui/modals.ts` 2,627 行、`src/ui/settings-tab.ts` 2,566 行 | 侧边栏视图的界面与业务仍在同一个类里；设置页已分 8 个 tab 与可折叠分区，但必配项与高级项仍位于同一 tab |
| 依赖未锁定 | `"obsidian": "latest"` 及多个 `^` 版本范围 | 构建不可复现（`MAINTAINING.md §6` 已列为待办） |
| 笔记索引只写不读 | 每次收尾都会重算并写回 `lexvoice-note-index` 注释块，但 `src/` 内无消费方（侧边栏使用全文抽取），`readQnALogNoteIndex` 仅被测试调用 | 每次收尾多一次笔记写入，结果未被使用 |
| 分段说话人编号 | 分段模式下跨段编号不保证指向同一人 | 已知限制；只有整文件导入能保证全场一致 |
| 历史命名保留 | `lexvoice/*` 标签、`LexVoice/` 默认目录、混淆盐仍是上游命名 | 内部标识符与 CSS 类名已于 2026-09-14 改为 `QnALog`/`qnalog-`；数据层需单独立项迁移，插件不自动重命名已有目录 |

其他待办见 `MAINTAINING.md §6`。

---

## 8. 术语对照

| 术语 | 含义 |
|---|---|
| 模式 mode | 一次会话的体裁与提示词契约（综合、工作、访谈、个人、学习、研讨、圆桌、仅转写） |
| 分段 segment | 一个音频切片及其转写文本，链路上的最小单位 |
| 分部 part | 纪要流水线划分的时间窗口，模型一次处理一个 |
| 断点 checkpoint | 分部的进度与产出，存为 JSON，支持只重跑未完成部分 |
| 整合版 | 笔记中模型产出的正文块（`## 整合版（模型 · 模式）`） |
| 原始材料 | 笔记底部的分段逐字稿，由标记界定，不删除 |
| 沉淀 sediment | 从笔记提取人员、待办、学习卡片、热词四类候选并写入库中的流程 |
| 热词 hotword | 词汇表中的条目，用于提升 ASR 识别准确率（分六个区） |
| 人员上下文模式 | `privacy` / `hotwords` / `localFull`，决定人名是否离开本机 |
| 方案 profile | 已保存的 LLM 配置（含密钥），切换时写入当前工作字段 |
| 沉淀进度条 | 沉淀侧边栏顶部的四段进度控件（源码标识为 `sediment-baton`） |
| 回听时间轴 | 笔记中将章节锚点与音频位置对应的可点击时间线 |
