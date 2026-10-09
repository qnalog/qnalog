const stringifyFrontmatterTag = String as (value: unknown) => string;

export function getFrontmatterTags(frontmatter: unknown): string[] {
  if (!frontmatter || typeof frontmatter !== "object") return [];
  const fields = frontmatter as Record<string, unknown>;
  const raw = fields.tags || fields.tag;
  if (Array.isArray(raw)) return raw.map((tag: unknown) => stringifyFrontmatterTag(tag).trim()).filter(Boolean);
  return stringifyFrontmatterTag(raw || "")
    .split(/[,\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}
