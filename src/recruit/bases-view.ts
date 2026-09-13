/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Obsidian Bases view API exposes dynamic entries/groups; this adapter guards at runtime and avoids requiring newer API typings. */
// @ts-nocheck
// QnALog 自定义 Bases 视图：招聘看板（kanban）。
// 用官方 Bases 插件 API（registerBasesView，@since 1.10.0）自绘候选人卡片，彻底解决静态 .base 的两个痛点：
//   ① table 单元格截断长文本（一句话评价）—— 自绘 div + CSS 整段换行；
//   ② file.name 列在嵌入看板里不可点 —— 直接用 entry.file(TFile) + workspace.openLinkText 造真链接。
// 额外红利（静态 .base 给不了的）：BasesQueryResult.groupedData 自带按用户 groupBy 分桶 → 真·按状态分列的看板。
//
// 关键约束：本文件引用的 Bases 符号（BasesView/registerBasesView/BasesEntry/getValue 等）全部 @since 1.10.0，
// 故 manifest.minAppVersion 必须 ≥ 1.10.0（运行时守卫消不掉 no-unsupported-api 静态发现）。
// 刻意避开 @since 1.10.2 的成员（createFileForView / getEvaluatedFormula / file·folder·formula 选项），把地板钉在 1.10.0。
import * as obsidian from "obsidian";

export const RECRUIT_BOARD_VIEW_ID = "lexvoice-recruit-board";

// 录用建议 → 语义色档（配合 styles.css 的彩色圆点/胶囊，不用 emoji）。招聘看板与招聘主页共用，保证一致。
export function recommendationTone(text) {
  const s = String(text || "");
  if (!s) return "neutral";
  if (s.includes("强烈推荐")) return "strong";
  if (s.includes("不推荐")) return "against"; // 含"倾向不推荐（条件性）"
  if (s.includes("推荐")) return "for";
  if (s.includes("待") || s.includes("观望") || s.includes("保留")) return "hold";
  return "neutral";
}

function valueToText(v) {
  if (v == null) return "";
  try {
    const s = v.toString();
    return s == null ? "" : String(s);
  } catch {
    return "";
  }
}

/**
 * 在插件 onload 里调用。Obsidian < 1.10 / Bases 未启用时安全降级（返回 false，不抛错、不污染加载）。
 * 类定义放在函数内部：`extends obsidian.BasesView` 只在守卫通过后才求值，
 * 避免老版本里 BasesView 为 undefined 导致 `class extends undefined` 在模块导入期直接 crash 整个插件。
 */
export function registerRecruitBoardView(plugin) {
  try {
    if (!plugin || typeof plugin.registerBasesView !== "function") return false;
    if (!obsidian.BasesView) return false;

    class RecruitBoardView extends obsidian.BasesView {
      constructor(controller, containerEl) {
        super(controller);
        this.type = RECRUIT_BOARD_VIEW_ID;
        this.rootEl = containerEl;
      }

      onload() {
        this.rootEl.addClass("lexvoice-recruit-board");
        // 单一委托点击：避免每次重渲染都 registerDomEvent 累积句柄。卡片带 data-lvrb-path，点开即跳纪要。
        this.registerDomEvent(this.rootEl, "click", (evt) => {
          const target = evt.target;
          const anchor = target && target.closest ? target.closest("[data-lvrb-path]") : null;
          if (!anchor) return;
          const path = anchor.getAttribute("data-lvrb-path");
          if (!path) return;
          evt.preventDefault();
          const newLeaf = !!(evt.ctrlKey || evt.metaKey);
          void this.app.workspace.openLinkText(path, path, newLeaf);
        });
      }

      onDataUpdated() {
        try {
          this.renderBoard();
        } catch (e) {
          console.error("[QnALog] RecruitBoardView render", e);
        }
      }

      renderBoard() {
        const root = this.rootEl;
        root.empty();
        const result = this.data; // 每次都是新对象，绝不跨次缓存（d.ts 明确警告）
        const groups = (result && result.groupedData) || [];
        if (!groups.length) {
          root.createDiv({
            cls: "lexvoice-rb-empty",
            text: "暂无候选人。把面试纪要放进本项目文件夹，整理出评估后即出现在这里。",
          });
          return;
        }

        // groupedData 长度 > 1，或单组带 key（用户设了 groupBy）→ 看板分列；否则单列卡片流。
        const grouped = groups.length > 1 || (groups[0] && typeof groups[0].hasKey === "function" && groups[0].hasKey());
        const board = root.createDiv({ cls: "lexvoice-rb-board" + (grouped ? " is-kanban" : " is-stream") });

        for (const group of groups) {
          const col = board.createDiv({ cls: "lexvoice-rb-col" });
          const hasKey = group && typeof group.hasKey === "function" && group.hasKey();
          const entries = (group && group.entries) || [];
          if (grouped) {
            const head = col.createDiv({ cls: "lexvoice-rb-colhead" });
            const label = hasKey ? valueToText(group.key) || "（空）" : "未分组";
            head.createSpan({ cls: "lexvoice-rb-coltitle", text: label });
            head.createSpan({ cls: "lexvoice-rb-colcount", text: String(entries.length) });
          }
          const cards = col.createDiv({ cls: "lexvoice-rb-cards" });
          for (const entry of entries) this.renderCard(cards, entry);
        }
      }

      cell(entry, propId) {
        try {
          return valueToText(entry.getValue(propId));
        } catch {
          return "";
        }
      }

      renderCard(container, entry) {
        const file = entry && entry.file;
        const card = container.createDiv({ cls: "lexvoice-rb-card" });

        const name = this.cell(entry, "note.候选人");
        const fileName = file ? file.basename || file.name || "" : "";
        const titleText = name || fileName || "未命名纪要";

        // 标题=可点链接（跳回原始面试纪要）
        const title = card.createEl("a", { cls: "lexvoice-rb-title", text: titleText, href: "#" });
        if (file && file.path) title.setAttribute("data-lvrb-path", file.path);

        // 元信息行：轮次 + 录用建议胶囊
        const round = this.cell(entry, "note.轮次");
        const rec = this.cell(entry, "note.录用建议");
        if (round || rec) {
          const meta = card.createDiv({ cls: "lexvoice-rb-meta" });
          if (round) meta.createSpan({ cls: "lexvoice-rb-round", text: round });
          if (rec) {
            const chip = meta.createSpan({ cls: "lexvoice-rb-chip", text: rec });
            chip.setAttribute("data-tone", recommendationTone(rec));
          }
        }

        // 一句话评价：整段换行，不截断（痛点①的正解）
        const evalText = this.cell(entry, "note.一句话评价");
        if (evalText) card.createDiv({ cls: "lexvoice-rb-eval", text: evalText });

        // 页脚：面试时间 + 纪要文件名（次级可点入口）
        const time = this.cell(entry, "note.time");
        const footer = card.createDiv({ cls: "lexvoice-rb-foot" });
        if (time) footer.createSpan({ cls: "lexvoice-rb-time", text: time });
        if (fileName) {
          const src = footer.createEl("a", { cls: "lexvoice-rb-src", text: fileName, href: "#" });
          if (file && file.path) src.setAttribute("data-lvrb-path", file.path);
        }
      }
    }

    return plugin.registerBasesView(RECRUIT_BOARD_VIEW_ID, {
      name: "招聘看板",
      icon: "users",
      factory: (controller, containerEl) => new RecruitBoardView(controller, containerEl),
    });
  } catch (e) {
    console.error("[QnALog] registerRecruitBoardView 失败", e);
    return false;
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of dynamic-typing region */
