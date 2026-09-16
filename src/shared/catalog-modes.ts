/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。

export const MODE_META = {
  synthesis: { prefix: "综合纪要", emoji: "", icon: "layers", label: "综合纪要", goal: "Best for most meetings. First distill the through-line of the whole session, then organize it in three layers: overview, body, and reference material." },
  meeting:   { prefix: "工作纪要", emoji: "📝", icon: "briefcase", label: "工作纪要", goal: "Best for work meetings of any size: decisions, todos, risks, and aligning on colleagues' progress." },
  interview: { prefix: "访谈", emoji: "🎙", icon: "message-square", label: "访谈", goal: "Best for external interviews, user research, and expert interviews, turning Q&A into insight." },
  monologue: { prefix: "个人笔记", emoji: "💭", icon: "notebook", label: "个人笔记", goal: "Best for personal dictation, ideas, and retrospectives, turning scattered expression into usable notes." },
  learning:  { prefix: "学习笔记", emoji: "📚", icon: "book-open", label: "学习笔记", goal: "Best for high information density content such as Bilibili, YouTube, courses, lectures, and podcasts." },
  seminar:   { prefix: "研讨会", emoji: "🧠", icon: "landmark", label: "研讨会", goal: "Best for academic seminars, themed salons, and roundtable forums, laying out viewpoints, disputes, evidence, and follow-up questions clearly." },
  huddle:    { prefix: "圆桌讨论", emoji: "🤝", icon: "users", label: "圆桌讨论", goal: "Kept for compatibility with older notes; for new recordings, please switch to \"Work Summary\".", legacy: true },
  off:       { prefix: "录音", emoji: "🎙", icon: "mic", label: "关闭（仅转写）" },
};

export const FRONTMATTER_SCHEMA = {
  synthesis: `主题: <一句话主题>
核心问题: <这场讨论真正在攻的那一个问题；即脊柱，一句话>
参与者:
  - <姓名或中性角色；不确定时写 "未提及">`,
  learning: `主题: <一句话主题>
来源: <B站 / YouTube / 播客 / 课程 / 讲座 / 未提及>
语言: <中文 / 英文 / 日文 / 多语种 / 未提及>`,
  interview: `主题: <一句话主题>
受访者:
  - <受访者姓名；推断不确定时写代号如 "受访者A（推断）">
访问者: <访问者姓名；未提及写 "未提及">`,
  meeting: `主题: <一句话主题>
参会人:
  - <姓名 1；不确定时用中性角色如 "业务需求方" 或写 "未提及">
  - <姓名 2>`,
  seminar: `主题: <一句话主题>
研讨对象: <理论 / 议题 / 案例 / 文本 / 项目；未提及写 "未提及">
参与者:
  - <姓名或角色；不确定时用 "发言人A（推断）" 或写 "未提及">`,
  huddle: `主题: <一句话主题>
当事人: <决策当事人；未点明写 "未提及"，不要凭一两句假设句指认>
参谋:
  - <参谋姓名或角色；不确定写 "未提及">`,
  monologue: `主题: <一句话主题>`,
};

export const MODE_PREFIX_TO_KEY = {
  // 旧 prefix
  "访谈": "interview",
  "会议": "meeting",
  "研讨会": "seminar",
  "研讨": "seminar",
  "沙龙": "seminar",
  "小会": "huddle",
  "手记": "monologue",
  "学习": "learning",
  "讨论": "huddle",
  // 新 prefix
  "综合纪要": "synthesis",
  "综合": "synthesis",
  "工作纪要": "meeting",
  "学术研讨": "seminar",
  "主题沙龙": "seminar",
  "访谈调研": "interview",
  "个人笔记": "monologue",
  "学习记录": "learning",
  "圆桌讨论": "huddle",
};
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
