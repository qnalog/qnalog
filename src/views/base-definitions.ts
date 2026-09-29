/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：资料库 .base 视图定义（纯数据）



import { NS_FM } from "../shared/namespace";

export const LV_BASE_DEFINITIONS = [
  // —— 按模式 ——
  {
    relPath: "按模式/所有会议.base",
    yaml: `filters:
  and:
    - file.hasTag("qnalog/meeting")
properties:
  file.name:
    displayName: 笔记
  note.${NS_FM.time}:
    displayName: 时间
  note.${NS_FM.topic}:
    displayName: 主题
  note.${NS_FM.participants}:
    displayName: 参会人
  note.tags:
    displayName: 标签
views:
  - type: table
    name: 列表
    order:
      - file.name
      - note.${NS_FM.time}
      - note.${NS_FM.topic}
      - note.${NS_FM.participants}
      - note.tags
    sort:
      - property: note.${NS_FM.time}
        direction: DESC
`,
  },
  {
    relPath: "按模式/内部小会.base",
    yaml: `filters:
  and:
    - file.hasTag("qnalog/huddle")
properties:
  file.name:
    displayName: 笔记
  note.${NS_FM.time}:
    displayName: 时间
  note.${NS_FM.coreQuestion}:
    displayName: 议题
  note.${NS_FM.decisionMaker}:
    displayName: 当事人
  note.${NS_FM.advisors}:
    displayName: 参谋
views:
  - type: table
    name: 列表
    order:
      - file.name
      - note.${NS_FM.time}
      - note.${NS_FM.coreQuestion}
      - note.${NS_FM.decisionMaker}
      - note.${NS_FM.advisors}
    sort:
      - property: note.${NS_FM.time}
        direction: DESC
`,
  },
  {
    relPath: "按模式/所有访谈.base",
    yaml: `filters:
  and:
    - file.hasTag("qnalog/interview")
properties:
  file.name:
    displayName: 笔记
  note.${NS_FM.time}:
    displayName: 时间
  note.${NS_FM.topic}:
    displayName: 主题
  note.${NS_FM.interviewee}:
    displayName: 受访者
  note.${NS_FM.interviewer}:
    displayName: 访问者
views:
  - type: table
    name: 列表
    order:
      - file.name
      - note.${NS_FM.time}
      - note.${NS_FM.topic}
      - note.${NS_FM.interviewee}
      - note.${NS_FM.interviewer}
    sort:
      - property: note.${NS_FM.time}
        direction: DESC
`,
  },
  {
    relPath: "按模式/独白手记.base",
    yaml: `filters:
  and:
    - file.hasTag("qnalog/monologue")
properties:
  file.name:
    displayName: 笔记
  note.${NS_FM.time}:
    displayName: 时间
  note.${NS_FM.topic}:
    displayName: 主题
views:
  - type: table
    name: 列表
    order:
      - file.name
      - note.${NS_FM.time}
      - note.${NS_FM.topic}
    sort:
      - property: note.${NS_FM.time}
        direction: DESC
`,
  },

  // —— 场景 ——
  {
    relPath: "场景/本周纪要.base",
    yaml: `filters:
  and:
    - file.hasTag("qnalog")
    - date(note.${NS_FM.time}) >= date("today") - "7 days"
properties:
  file.name:
    displayName: 笔记
  note.${NS_FM.time}:
    displayName: 时间
  note.${NS_FM.mode}:
    displayName: 模式
  note.${NS_FM.topic}:
    displayName: 主题
  note.tags:
    displayName: 标签
views:
  - type: table
    name: 本周
    order:
      - file.name
      - note.${NS_FM.time}
      - note.${NS_FM.mode}
      - note.${NS_FM.topic}
      - note.tags
    sort:
      - property: note.${NS_FM.time}
        direction: DESC
`,
  },
  {
    relPath: "场景/决策与待办.base",
    yaml: `filters:
  or:
    - file.hasTag("qnalog/meeting")
    - file.hasTag("qnalog/huddle")
properties:
  file.name:
    displayName: 笔记
  note.${NS_FM.time}:
    displayName: 时间
  note.${NS_FM.mode}:
    displayName: 类型
  note.${NS_FM.topic}:
    displayName: 主题
  note.${NS_FM.coreQuestion}:
    displayName: 议题
  note.${NS_FM.participants}:
    displayName: 参会人
  note.${NS_FM.decisionMaker}:
    displayName: 当事人
  note.tags:
    displayName: 标签
views:
  - type: table
    name: 列表
    order:
      - file.name
      - note.${NS_FM.time}
      - note.${NS_FM.mode}
      - note.${NS_FM.topic}
      - note.${NS_FM.coreQuestion}
      - note.${NS_FM.participants}
      - note.${NS_FM.decisionMaker}
      - note.tags
    sort:
      - property: note.${NS_FM.time}
        direction: DESC
`,
  },
  {
    relPath: "场景/全部纪要总览.base",
    yaml: `filters:
  and:
    - file.hasTag("qnalog")
properties:
  file.name:
    displayName: 笔记
  note.${NS_FM.time}:
    displayName: 时间
  note.${NS_FM.mode}:
    displayName: 模式
  note.${NS_FM.topic}:
    displayName: 主题
  note.${NS_FM.coreQuestion}:
    displayName: 议题
  note.tags:
    displayName: 主题词
views:
  - type: table
    name: 全部
    order:
      - file.name
      - note.${NS_FM.time}
      - note.${NS_FM.mode}
      - note.${NS_FM.topic}
      - note.${NS_FM.coreQuestion}
      - note.tags
    sort:
      - property: note.${NS_FM.time}
        direction: DESC
`,
  },
];




/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
