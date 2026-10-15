export type TopicErrataSection = "offTopic" | "notes";
export type TopicErrataLanguage = "zh" | "en";

const TITLES: Record<TopicErrataLanguage, Record<TopicErrataSection, string>> = {
  zh: { offTopic: "不属于本主题", notes: "说明" },
  en: { offTopic: "Off-topic", notes: "Notes" },
};

export function getTopicErrataSectionKey(title: string): TopicErrataSection | null {
  const normalized = String(title || "").trim().toLocaleLowerCase();
  if (normalized === "不属于本主题" || normalized === "off-topic") return "offTopic";
  if (normalized === "说明" || normalized === "notes") return "notes";
  return null;
}

export function getTopicErrataTitles(language: string): Record<TopicErrataSection, string> {
  return TITLES[language === "zh" ? "zh" : "en"];
}

export function getTopicErrataSuffix(language: string): string {
  return language === "zh" ? "勘误" : "Errata";
}

export function getTopicErrataTopicLabel(language: string): string {
  return language === "zh" ? "主题：" : "Topic: ";
}
