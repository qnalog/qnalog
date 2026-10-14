export type ErrataSection = "replacements" | "noise" | "notes";
export type ErrataLanguage = "zh" | "en";
export type ErrataSectionTitles = Record<ErrataSection, string>;

export const ERRATA_SECTION_ALIASES: Record<ErrataSection, readonly string[]> = {
  replacements: ["替换", "Replace"],
  noise: ["噪音", "Noise"],
  notes: ["说明", "Notes"],
};

export function getErrataSectionKey(title: string): ErrataSection | null {
  const normalized = String(title || "").trim().toLowerCase();
  for (const [section, aliases] of Object.entries(ERRATA_SECTION_ALIASES) as Array<[ErrataSection, readonly string[]]>) {
    if (aliases.some((alias) => alias.toLowerCase() === normalized)) return section;
  }
  return null;
}

export function getErrataSectionTitles(language: string): ErrataSectionTitles {
  return language === "zh"
    ? { replacements: "替换", noise: "噪音", notes: "说明" }
    : { replacements: "Replace", noise: "Noise", notes: "Notes" };
}

export function getErrataNoteLabel(language: string): string {
  return language === "zh" ? "笔记：" : "Note: ";
}

export function getErrataFilenameSuffix(language: string): string {
  return language === "zh" ? "勘误" : "Errata";
}
