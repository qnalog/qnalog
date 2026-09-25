# QnALog 设计规范 · v2

本文是 QnALog 插件 UI 的实现基准。每次改动前先对照本文，完成后按自查清单核对。

## 1. 核心原则

- QnALog 是 Obsidian 插件，颜色必须融入当前主题和 Style Settings 配置。
- 视觉个性来自结构：大纲 / 沉淀 / 纪要三 tab、时间轴语言、沉淀流水线、轻量编辑机制。
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
  --qnalog-border-line-hover: var(--background-modifier-border-hover);

  --qnalog-primary: var(--interactive-accent);
  --qnalog-primary-hover: var(--interactive-accent-hover);
  --qnalog-text-active: var(--text-accent);
  --qnalog-bg-active: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
  --qnalog-bg-active-strong: color-mix(in srgb, var(--interactive-accent) 22%, transparent);
  --qnalog-border-active: var(--interactive-accent);
  --qnalog-border-active-soft: color-mix(in srgb, var(--interactive-accent) 35%, transparent);

  /* 录音/进行中也跟随主题强调色，不硬编码红色。 */
  --qnalog-recording-color: var(--interactive-accent);
  --qnalog-recording-glow: color-mix(in srgb, var(--interactive-accent) 25%, transparent);

  --qnalog-success-bg: var(--background-modifier-success);
  --qnalog-success-text: var(--text-success);
  --qnalog-danger-bg: var(--background-modifier-error);
  --qnalog-danger-text: var(--text-error);
}

.theme-dark .qnalog-outline,
.theme-dark .qnalog-view {
  --qnalog-bg-active: color-mix(in srgb, var(--interactive-accent) 18%, transparent);
  --qnalog-bg-active-strong: color-mix(in srgb, var(--interactive-accent) 28%, transparent);
}
```

规则：

- 所有颜色使用 `var(--qnalog-*)` 或 Obsidian 官方变量。
- 错误 / 失败 / 重试使用 `--qnalog-danger-text`，最终指向 `--text-error`。
- 成功使用 `--qnalog-success-*`，最终指向 Obsidian 成功语义色。
- 录音、进行中圆点、波形和进度使用 `--qnalog-recording-color`，最终指向 `--interactive-accent`。
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

- [ ] 颜色跟随 Obsidian 强调色和 Style Settings。
- [ ] 错误 / 重试图标使用 `text-error` 语义色。
- [ ] 深色模式无白底残留。
- [ ] 侧边栏左右有稳定 padding。
- [ ] 空状态有 56px 圆形图标、13px 主文案、11px 副文案和引导按钮。
- [ ] 章节播放时小圆点存在，时间轴不位移。
- [ ] 播放按钮图标正确显示。
- [ ] 热词候选单行展示，不出现三行字段视图。
- [ ] 指挥棒 current / pending / done / empty 四态可区分。
- [ ] `npm run build` 通过。
