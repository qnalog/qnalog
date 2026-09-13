import type { SpeakerId, SpeakerMapping } from "../audio/channel-speakers";

export interface SpeakerCandidate {
  id: SpeakerId;
  label: string;
  samples: string[];
}

function speakerIdFromNumber(value: unknown): SpeakerId {
  return `spk-${Math.max(1, Number(value) || 1)}`;
}

function cleanSample(value: unknown): string {
  return (typeof value === "string" ? value : "")
    .replace(/<!--\s*lexvoice-speaker:[^>]+-->/gi, "")
    .replace(/^\s*[-*]+\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

export function collectSpeakerCandidates(markdown: unknown, maxSamples = 2): SpeakerCandidate[] {
  const text = typeof markdown === "string" ? markdown : "";
  const byId = new Map<SpeakerId, SpeakerCandidate>();
  const pattern = /(?:\[\s*说话人\s*(\d+)\s*\]|\*{0,2}\s*说话人\s*(\d+)\s*[：:]\s*\*{0,2})\s*([^\n]*)/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const number = Number(match[1] || match[2]) || 1;
    const id = speakerIdFromNumber(number);
    const candidate = byId.get(id) || { id, label: `说话人${number}`, samples: [] };
    const sample = cleanSample(match[3]);
    if (sample && candidate.samples.length < maxSamples && !candidate.samples.includes(sample)) {
      candidate.samples.push(sample);
    }
    byId.set(id, candidate);
  }
  return Array.from(byId.values()).sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
}

export function applySpeakerNamesForLlm(
  markdown: unknown,
  mappings: Record<string, SpeakerMapping> | null | undefined,
): string {
  let text = typeof markdown === "string" ? markdown : "";
  for (const mapping of Object.values(mappings || {})) {
    const name = String(mapping && mapping.personName || "").trim();
    const channel = Number(mapping && mapping.channel) || Number(String(mapping && mapping.id || "").replace(/^spk-/, ""));
    if (!name || !channel) continue;
    text = text
      .replace(new RegExp(`\\[\\s*说话人\\s*${channel}\\s*\\]`, "gi"), `[${name}]`)
      .replace(new RegExp(`(\\*{0,2})\\s*说话人\\s*${channel}\\s*[：:]\\s*(\\*{0,2})`, "gi"), (_match, open, close) => `${open}${name}：${close}`);
  }
  return text;
}

export function buildConfirmedSpeakerMappings(
  candidates: SpeakerCandidate[],
  names: Record<string, string>,
  existing: Record<string, SpeakerMapping> = {},
): Record<SpeakerId, SpeakerMapping> {
  const result = {} as Record<SpeakerId, SpeakerMapping>;
  for (const candidate of candidates || []) {
    const channel = Math.max(1, Number(candidate.id.slice(4)) || 1);
    const previous = existing[candidate.id];
    const personName = String(names[candidate.id] || previous && previous.personName || "").trim();
    result[candidate.id] = {
      id: candidate.id,
      channel,
      label: candidate.label || `说话人${channel}`,
      ...(personName ? { personName } : {}),
      ...(previous && previous.personPath ? { personPath: previous.personPath } : {}),
    };
  }
  return result;
}
