import * as obsidian from "obsidian";
import { readNamespaceFrontmatter } from "../shared/namespace";

export interface NoteModeInferenceHost {
  getFileFrontmatter(file: obsidian.TFile): obsidian.CachedMetadata["frontmatter"];
  getTags(frontmatter: NonNullable<obsidian.CachedMetadata["frontmatter"]>): string[];
  normalizeLabel(label: string): string;
  isKnownMode(mode: string): boolean;
  inferFilename(basename: string): string;
  getCleanFallbackMode(): string;
}

export function detectModeFromMarkdownFlow(
  host: NoteModeInferenceHost,
  file: unknown,
): string | null {
  if (!(file instanceof obsidian.TFile)) return null;
  const cache = host.getFileFrontmatter(file);
  if (!cache) {
    const fallbackMode = host.inferFilename(file.basename);
    return fallbackMode && fallbackMode !== "off" ? fallbackMode : null;
  }
  const mode = readNamespaceFrontmatter(cache, "mode");
  if (mode === "cleanscript") {
    for (const tag of host.getTags(cache)) {
      const tagMode = host.normalizeLabel(tag);
      if (tagMode && tagMode !== "off" && host.isKnownMode(tagMode)) return tagMode;
    }
    const filenameMode = host.inferFilename(file.basename);
    if (filenameMode && filenameMode !== "off") return filenameMode;
    return host.getCleanFallbackMode();
  }
  if (typeof mode === "string" && host.isKnownMode(mode)) return mode;
  const fields = cache as Record<string, unknown>;
  // Preserve legacy String coercion, including custom toString behavior from frontmatter values.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Keep the original ToString coercion for frontmatter values.
  const typeStr = String(readNamespaceFrontmatter(cache, "type") || fields["模板"] || fields.template || "").trim();
  const typeToMode: Record<string, string> = {
    "学习": "learning",
    "学习记录": "learning",
    "学习视频": "learning",
    "视频学习": "learning",
    "课程笔记": "learning",
    "访谈": "interview",
    "访谈调研": "interview",
    "研讨": "seminar",
    "研讨会": "seminar",
    "学术研讨": "seminar",
    "主题沙龙": "seminar",
    "会议": "meeting",
    "工作纪要": "meeting",
    "小会": "huddle",
    "讨论": "huddle",
    "圆桌讨论": "huddle",
    "独白": "monologue",
    "手记": "monologue",
    "个人笔记": "monologue",
  };
  if (typeToMode[typeStr]) {
    const mappedMode = typeToMode[typeStr];
    return host.isKnownMode(mappedMode) ? mappedMode : null;
  }
  const fallbackMode = host.inferFilename(file.basename);
  return fallbackMode && fallbackMode !== "off" ? fallbackMode : null;
}
