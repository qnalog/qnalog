# QnALog 设计规范 · v2

本文是 QnALog 插件 UI 的实现基准。每次改动前先对照本文，完成后按自查清单核对。

## 1. 核心原则

- QnALog 是 Obsidian 插件，颜色必须融入当前主题和 Style Settings 配置。
- 视觉识别来自五个侧边栏标签（大纲 / 沉淀 / 问一问 / 纪要 / 主题）、QnALog 标识、时间轴语言、沉淀流水线和轻量编辑机制。
- 常态界面保持克制：少边框、浅背景、小字号、明确动作。
- 状态切换不能靠 `transform` 推动布局，避免时间轴和列表发生位移。

## 2. 颜色系统

QnALog 变量必须从 Obsidian 官方变量派生。不要写死产品色板。

```css
.qnalog-outline,
.qnalog-view {
  --qnalog-bg-base: var(--background-primary);
  --qnalog-bg-card: var(--background-primary-alt, var(--background-primary));
  --qnalog-bg-muted: var(--background-secondary);
  --qnalog-bg-hover: var(--background-modifier-hover);

  --qnalog-text-primary: var(--text-normal);
  --qnalog-text-secondary: var(--text-muted);
  --qnalog-text-tertiary: var(--text-faint);
  --qnalog-text-hint: var(--text-faint);
  --qnalog-on-primary: var(--text-on-accent);

  --qnalog-border-line: var(--background-modifier-border);

  --qnalog-primary: var(--interactive-accent);
  --qnalog-primary-hover: var(--interactive-accent-hover);
  --qnalog-text-active: var(--text-accent);
  --qnalog-bg-active: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
  --qnalog-border-active: var(--interactive-accent);
  --qnalog-border-active-soft: color-mix(in srgb, var(--interactive-accent) 35%, transparent);

  /* 录音停止控件使用主题错误语义色；普通活跃状态仍使用强调色。 */
  --qnalog-recording-color: var(--text-error);
  --qnalog-recording-glow: color-mix(in srgb, var(--text-error) 25%, transparent);

  --qnalog-success-bg: var(--background-modifier-success);
  --qnalog-success-text: var(--text-success);
  --qnalog-danger-bg: var(--background-modifier-error);
  --qnalog-danger-text: var(--text-error);
}

.theme-dark .qnalog-outline,
.theme-dark .qnalog-view {
  --qnalog-bg-active: color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}
```

规则：

- 所有颜色使用 `var(--qnalog-*)` 或 Obsidian 官方变量。
- 错误 / 失败 / 重试使用 `--qnalog-danger-text`，最终指向 `--text-error`。
- 成功使用 `--qnalog-success-*`，最终指向 Obsidian 成功语义色。
- 录音停止控件使用 `--qnalog-recording-color`，最终指向 Obsidian 的 `--text-error`；普通进行中状态使用 `--interactive-accent`。
- 不要把主题主色、错误色、成功色写成固定 hex。

## 3. 间距规范

- 视图根容器：左右至少 `18px` padding。
- tab 头到内容：`16px`，空状态可放大到 `28px`。
- 模块之间：`14px` 到 `16px`。
- 列表项之间用子项 `margin-top` 控制，不要父级 `gap` 和子项 margin 混用。
- 文本层级：
  - 标题到副信息：`3px`
  - 标题到要点区：`8px`
  - 要点之间靠 `line-height: 1.7`

严禁用空 div、`<br>`、额外 padding 制造大段空白。

### 标题与纪要列表动作

- 侧栏标题中的 Q 标记与产品名保持同一水平行；录音态允许标题文字收缩或省略，但不让标记独占一行或与文字重叠。
- 纪要列表标题行使用完整内容宽度；重命名、重试和状态标记与元数据并排显示，避免状态图标挤压标题。窄宽度下标题可省略，操作仍须可见和可达。

此处不改变纪要打开、重命名、重试或查看状态的行为。

## 4. 字号规范

| 用途 | 字号 | 字重 | 行高 |
|---|---:|---:|---:|
| 卡片主标题 | 14px | 500 | 1.4 |
| 列表项标题 | 13px | 500 | 1.4 |
| 空状态主文案 | 13px | 500 | 1.4 |
| 正文要点 | 12px | 400 | 1.7 |
| 副信息 / 元数据 | 11px | 400 | 1.5 |
| 类型胶囊 | 10px | 400 | 1 |

## 5. 空状态

空状态必须使用“图标容器 + 主文案 + 副文案 + 引导按钮”，不要直接放一段说明文字。

```html
<div class="qnalog-empty-state">
  <div class="qnalog-empty-state-icon"><i class="ti ti-file-text"></i></div>
  <div class="qnalog-empty-state-title">还没有打开纪要</div>
  <div class="qnalog-empty-state-desc">从纪要列表选一篇打开，<br>就能开始沉淀人、事、知、热词</div>
  <button class="qnalog-empty-state-action"><i class="ti ti-list"></i><span>打开纪要列表</span></button>
</div>
```

关键尺寸：

- 图标容器：`56px` 圆，`0.5px` 主题边框。
- 主文案：`13px / 500`。
- 副文案：`11px / 1.6`。
- 引导按钮：次按钮样式，透明底 + 主题边框。

## 6. 沉淀流水线

- 指挥棒两行：状态行 + 节点流水线。
- current：活跃浅底 + 主色描边 + 实心数字圆。
- pending：透明 + 空心圆 + 次级文字。
- done：成功浅底圆 + check 图标 + 成功文字。
- empty：极弱文字，不可点击。
- 点击 pending 可跳转处理，点击 done 进入回看，current / empty 不响应。

热词和人员这种单行候选必须一行展示：复选框 / 图标 + 名称 + 10px 类型胶囊。不要把中文类型和英文字段拆成多行。

## 7. 时间轴与播放器

- 时间轴圆点是独立 div，不是图标。
- 普通圆点：`8px` 空心圆。
- 正在播放：`10px` 实心圆 + 主题光晕。
- 时间轴竖线必须穿过圆心，不能因播放态切换发生偏移。
- 播放态只能改变 background / opacity / color，禁止 `transform` 和改变垂直 margin。

播放器：

- 播放按钮 `28px` 圆，内部使用 Tabler icon。
- 进度条 `3px`，handle `9px`。
- 当前时间用 `--qnalog-text-active`，总时长用 `--qnalog-text-tertiary`。

## 8. 严禁清单

### 主题标签页与对话框

- 五个标签使用等宽弹性布局，标题不换行、不横向溢出；窄栏保持五项可见，按钮文字按可用宽度省略。
- 主题列表复用纪要列表的行结构与样式：图标块、名称、`n 篇笔记 · 最近更新 MM-DD`、操作区（待整合胶囊与 ⋯ 菜单，⋯ 与右键菜单相同）。当前笔记所在行高亮，切换时只改高亮，不重建列表。
- 创建对话框按项目标签、主题类标签、内容相近分组，显示来源日期、标题、概要、命中原因和成员徽标。概要展开不改变行顺序。
- 扫描对话框与创建对话框共用候选行和分组标题；标签原因显示在摘要下方的可换行元信息行。
- 打开主题页与来源笔记时，若该笔记已在某个标签页中打开，则切换到该标签页，不再新开；主题列表点击、创建或应用后的打开、预览中的来源链接都遵循此规则。
- 候选行与预览条目整行可点击：点击标题、概要、原因文字或行内空白都切换勾选；展开概要、来源链接与拖选文字不切换。起点笔记行置灰（`aria-disabled`），点击无效。勾选只更新该行状态、分组标题的"已选 n / 共 m"与创建按钮，不重建列表；空格键切换焦点复选框，焦点轮廓使用强调色。
- 生成预览时对话框切换为"正在生成预览"状态：显示依据与纪要篇数，批次数已知且大于一时进度条按已完成批次推进并显示"第 n/N 批"；否则为不确定动画加"处理中…"。显示已用秒数。取消回到候选列表并保留勾选与标题；失败显示错误摘要与重试按钮。减少动态效果偏好下不确定动画改为静态条与文字。
- 创建与预览对话框使用纵向弹性布局；标题和底部操作栏保持可见，候选或预览列表在 `min(70vh, 640px)` 的区域内纵向滚动。
- 预览按主题章节分组；操作正文占主要宽度并自然换行，来源标题与日期排列在第二行；来源标题使用次要色小胶囊，未核实与分歧标记使用行内小胶囊。冲突项用次级背景与语义描边区分。
- 创建、生成与预览对话框使用 Obsidian 标题区，标题为“QnALog · 主题”；内容首行以次要色小标题显示当前动作。生成状态按内容确定高度，候选列表恢复时使用列表滚动高度限制。
- 预览条目的正文在上，元信息行在下并右对齐显示来源标题与日期；徽标在同一行左侧。来源标签使用次要色小标签，条目垂直留白为 12px，章节间距为 20px。
- 创建和预览对话框使用主题背景、边框、文字与强调色变量。输入、单选、复选控件保持可见键盘焦点；窄屏内容可纵向滚动且不产生横向溢出。
- 分歧项标题包含复选框和提示图标，多个立场纵向排列；预览条目只显示可读标题，不显示操作码。
- 主题相关对话框统一使用“QnALog · 主题”标题栏；确认框通过 `qnalogConfirm` 的可选标题参数启用该样式，其他确认框保持原样。
- 纪要或主题标签页处于浏览状态时，打开或聚焦笔记不切换侧栏标签，列表保留各自的滚动位置；当前笔记所在行加高亮，高亮不滚动列表。录音开始、结束与收尾仍切到大纲。
- 主题列表沿用侧栏内容 `16px` 的水平留白、纪要列表的 `13px` 标题字号和细分隔线。
- 创建与更新预览使用普通 `div` 标题，避免继承主题标题色与字号；鼠标操作不显示焦点轮廓，键盘焦点使用 2px 强调色外轮廓和 2px 偏移。
- 主题页 v2 使用单语章节标题；开篇以 abstract callout 写 2–5 句概要，正文以三级标题组织进展线索。正文事实使用 Obsidian 脚注引用来源笔记，时间线按成员日期排序并由程序从概要卡生成。空的可选章节省略；线索间距和脚注字号使用 Obsidian 主题变量；页面属性保存块索引，正文不放行内块锚点。概要之后直接进入进展脉络。
- 新笔记提示作为纪要行之后的附加行，使用次级文字和紧凑操作按钮；不改变纪要行高、顺序或筛选。
- 浅色与深色主题使用 Obsidian 变量；减少动态效果偏好关闭新增动画与过渡。

- 硬编码主题色、主按钮色、活跃态底色。
- 用 `#FFF` 写按钮文字色，必须用 `var(--qnalog-on-primary)` 或 `var(--text-on-accent)`。
- 使用原生 `<select>` / checkbox / radio 做最终视觉。
- 给 button / input 留浏览器默认边框。
- 用 `<ul>` / `<ol>` / `<li>` / `<p>` / `<h1-h6>` 承载插件原生 UI 列表。
- 常态界面堆段落式说明文字。
- 把内部字段如 `people`、`brands`、`terms` 显示给用户。
- 单行候选高度超过 `36px`。
- toast 出现在内容中部；toast 应贴近侧边栏底部。

## 9. 自查清单

## 10. 笔记机器数据与标签

- 插件写入笔记的 `<!-- qnalog-… -->` 协议注释必须位于折叠的 `<details>` 内；details 内容连续排列，不插入空行。`<details>` 外的机器标记只使用不可见的空行内元素，例如版本区的 `<span data-qnalog="active-version-start"></span>`。
- 活动版本区起止标记使用行内元素；读取端同时识别既有注释和新元素格式。
- 索引数据折叠块位于「原始材料」区域末尾，与会话标记、会话知识和笔记索引标记放在同一块中。
- 读取端同时识别历史外置标记与折叠区内的新格式；正常重写单篇笔记时更新机器数据布局，不批量扫描或修改已有笔记。
- 分段转写的完整来源记录放在原始材料区、分段转写 `<details>` 之后的隐藏行内元素中，元素使用 `data-qnalog-transcript-data` 与 `data-qnalog-segment` 关联段落。长数据不放进 `<details>`；实时预览会延迟渲染约 7 kB 以上的折叠内容，73 kB 笔记会滚动到末尾才渲染。
- 模型或程序生成的 Obsidian 标签只保留 Unicode 字母、数字、`_`、`-`、`/`。清洗后合并连续斜线、去除首尾斜线并丢弃空标签与纯数字标签。
- 用户输入的标签和已有笔记中的标签按原值保留。

- [ ] 颜色跟随 Obsidian 强调色和 Style Settings。
- [ ] 错误 / 重试图标使用 `text-error` 语义色。
- [ ] 深色模式无白底残留。
- [ ] 侧边栏左右有稳定 padding。
- [ ] 空状态有 56px 圆形图标、13px 主文案、11px 副文案和引导按钮。
- [ ] 章节播放时小圆点存在，时间轴不位移。
- [ ] 播放按钮图标正确显示。
- [ ] 热词候选单行展示，不出现三行字段视图。
- [ ] 指挥棒 current / pending / done / empty 四态可区分。
- [ ] 侧栏、看板、设置页与弹窗的键盘焦点有可见主题色轮廓。
- [ ] `npm run build` 通过。
