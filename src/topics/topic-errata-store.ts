import { NS_FM } from "../shared/namespace";
import { parseTopicErrata, type ParsedTopicErrata } from "./topic-errata-parser";
import { getTopicErrataSectionKey, getTopicErrataSuffix, getTopicErrataTitles } from "./topic-errata-sections";
import type { ScopedTopicErrata, ScopedTopicErrataEntry } from "./topic-errata-prompt";

export interface TopicErrataStorePort {
  read(path: string): Promise<string | null>;
  create(path: string, content: string): Promise<void>;
  process(path: string, transform: (current: string) => string): Promise<void>;
  uiLanguage(): string;
  diagnostic?(code: string, data: Record<string, unknown>): void;
}

function normalizePath(path: string): string { return String(path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""); }
function pathMatchesMember(link: string, path: string): boolean {
  const target = normalizePath(link).replace(/\.md$/i, "").toLocaleLowerCase();
  const normalized = normalizePath(path).replace(/\.md$/i, "").toLocaleLowerCase();
  return target === normalized || (!target.includes("/") && normalized.split("/").pop() === target);
}
function renderDocument(title: string, sectionTitles: ReturnType<typeof getTopicErrataTitles>): string {
  return `---\n${NS_FM.topicErrata}: true\n---\n# ${title}\n\n## ${sectionTitles.offTopic}\n\n## ${sectionTitles.notes}\n`;
}
function insertionPoint(markdown: string): number | null {
  const lines = markdown.split(/\r?\n/);
  let offset = 0;
  for (const line of lines) {
    const ending = markdown.startsWith("\r\n", offset + line.length) ? 2 : markdown.startsWith("\n", offset + line.length) ? 1 : 0;
    const heading = line.match(/^\s*##\s+(.+?)\s*#*\s*$/);
    if (heading && getTopicErrataSectionKey(heading[1]) === "offTopic") return offset + line.length + ending;
    offset += line.length + ending;
  }
  return null;
}
function entryLine(description: string, memberPath?: string): string {
  const link = memberPath ? `[[${normalizePath(memberPath).replace(/\.md$/i, "")}]]：` : "";
  return `- ${link}${description.trim().replace(/\s+/g, " ")}`;
}

export class TopicErrataStore {
  private readonly port: TopicErrataStorePort;
  constructor(port: TopicErrataStorePort) { this.port = port; }

  pathForTopic(topicPath: string): string {
    const language = this.port.uiLanguage() === "zh" ? "zh" : "en";
    const suffix = getTopicErrataSuffix(language);
    const path = normalizePath(topicPath);
    const slash = path.lastIndexOf("/");
    const parent = slash >= 0 ? path.slice(0, slash + 1) : "";
    const name = path.slice(slash + 1).replace(/\.md$/i, "");
    return `${parent}${name} ${suffix}.md`;
  }

  async ensure(topicPath: string, title: string): Promise<string> {
    const path = this.pathForTopic(topicPath);
    if (await this.port.read(path) !== null) return path;
    const language = this.port.uiLanguage() === "zh" ? "zh" : "en";
    await this.port.create(path, renderDocument(title, getTopicErrataTitles(language)));
    return path;
  }

  async load(topicPath: string, memberPaths: readonly string[]): Promise<ScopedTopicErrata> {
    const markdown = await this.port.read(this.pathForTopic(topicPath));
    if (!markdown) return { entries: [], notes: [] };
    const parsed: ParsedTopicErrata = parseTopicErrata(markdown);
    const entries: ScopedTopicErrataEntry[] = parsed.entries.flatMap((entry): ScopedTopicErrataEntry[] => {
      if (!entry.memberLink) return [{ ...entry, memberPath: null }];
      const member = memberPaths.find((path) => pathMatchesMember(entry.memberLink || "", path));
      if (!member) {
        this.port.diagnostic?.("topic.errata_member_not_in_topic", { topicPath, memberLink: entry.memberLink });
        return [];
      }
      return [{ ...entry, memberPath: member }];
    });
    return { entries, notes: parsed.notes };
  }

  async append(topicPath: string, title: string, description: string, memberPath?: string): Promise<string> {
    const path = this.pathForTopic(topicPath);
    const language = this.port.uiLanguage() === "zh" ? "zh" : "en";
    const titles = getTopicErrataTitles(language);
    const content = entryLine(description, memberPath);
    await this.ensure(topicPath, title);
    await this.port.process(path, (markdown) => {
      const parsed = parseTopicErrata(markdown);
      const equivalentLink = memberPath ? normalizePath(memberPath).replace(/\.md$/i, "").toLocaleLowerCase() : null;
      if (parsed.entries.some((entry) => entry.description.toLocaleLowerCase() === description.trim().replace(/\s+/g, " ").toLocaleLowerCase()
        && ((entry.memberLink && memberPath && pathMatchesMember(entry.memberLink, memberPath)) || (!entry.memberLink && !equivalentLink)))) return markdown;
      const point = insertionPoint(markdown);
      if (point === null) return `${markdown.trimEnd()}\n\n## ${titles.offTopic}\n${content}\n`;
      return `${markdown.slice(0, point)}${content}\n${markdown.slice(point)}`;
    });
    return path;
  }
}
