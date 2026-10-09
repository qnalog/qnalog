import { readSpeakerMappings, speakerLabelForChannel } from "../audio/channel-speakers";
import { NS_FM } from "../shared/namespace";
import { primitiveText } from "../shared/util-common";

export type RoleMapping = { from: string; to: string };

export const ROLE_MAPPING_FIELDS: readonly string[] = [
  NS_FM.participants, NS_FM.advisors, NS_FM.interviewee, NS_FM.interviewer,
  NS_FM.decisionMaker, "参会人", "与会人", "参与者", "出席人", "参谋",
  "受访者", "访问者", "面试官", "候选人", "当事人",
];

const stringifyRoleMappingInput = String as (value: unknown) => string;
export function parseRoleMapItem(item: unknown): RoleMapping | null {
  const text = stringifyRoleMappingInput(item == null ? "" : item).trim();
  if (!text) return null;
  const match = text.match(/^(.+?)\s*(?:→|=>|->)\s*(.+)$/);
  if (!match) return null;
  const from = match[1].trim();
  const to = match[2].trim();
  if (!from || !to || from === to) return null;
  return { from, to };
}

export function extractRoleMappingFromFrontmatter(
  frontmatter: Record<string, unknown> | null | undefined,
): RoleMapping[] {
  if (!frontmatter || typeof frontmatter !== "object") return [];
  const mapping: RoleMapping[] = [];
  const seen = new Set<string>();
  for (const field of ROLE_MAPPING_FIELDS) {
    const value = frontmatter[field];
    if (Array.isArray(value)) {
      for (const item of value) {
        const parsed = parseRoleMapItem(item);
        if (parsed && !seen.has(parsed.from)) {
          mapping.push(parsed);
          seen.add(parsed.from);
        }
      }
    } else if (typeof value === "string") {
      const parsed = parseRoleMapItem(value);
      if (parsed && !seen.has(parsed.from)) {
        mapping.push(parsed);
        seen.add(parsed.from);
      }
    }
  }
  const speakers = readSpeakerMappings(frontmatter);
  if (speakers && typeof speakers === "object") {
    for (const [speakerId, item] of Object.entries(speakers)) {
      const channel = Number(String(speakerId).replace(/^spk-/, "")) || 0;
      if (!channel) continue;
      const personName = item && typeof item === "object"
        ? String((item as { personName?: string; name?: string }).personName || (item as { personName?: string; name?: string }).name || "").trim()
        : primitiveText(item).trim();
      if (!personName) continue;
      for (const from of [speakerLabelForChannel(channel), `说话人 ${channel}`]) {
        if (from && from !== personName && !seen.has(from)) {
          mapping.push({ from, to: personName });
          seen.add(from);
        }
      }
    }
  }
  return mapping;
}

export function applyRoleMappingToSegments<T extends { text?: string }>(
  segments: T[], mapping: RoleMapping[],
): T[] {
  if (!mapping.length) return segments;
  const sorted = [...mapping].sort((left, right) => right.from.length - left.from.length);
  return segments.map((segment) => {
    let text = segment.text || "";
    for (const item of sorted) {
      if (!item.from) continue;
      text = text.split(item.from).join(item.to);
    }
    return Object.assign({}, segment, { text });
  });
}

export function flattenRoleMappedFrontmatter(
  frontmatter: Record<string, unknown>, mapping: RoleMapping[],
): Record<string, unknown> {
  const flattened: Record<string, unknown> = Object.assign({}, frontmatter);
  if (!mapping.length) return flattened;
  for (const field of ROLE_MAPPING_FIELDS) {
    const value = flattened[field];
    if (Array.isArray(value)) {
      const values: unknown[] = value;
      flattened[field] = values.map((item) => {
        const parsed = parseRoleMapItem(item);
        return parsed ? parsed.to : item;
      });
    } else if (typeof value === "string") {
      const parsed = parseRoleMapItem(value);
      if (parsed) flattened[field] = parsed.to;
    }
  }
  return flattened;
}
