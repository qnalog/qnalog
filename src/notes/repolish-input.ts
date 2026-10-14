import { getCurrentTranscript } from "../transcript/session-transcript";
import { readSessionKnowledge } from "../briefing/session-knowledge";
import { readRepolishSessionTiming } from "./note-source-metadata";
import type { Segment } from "../shared/types";
import { applyErrataToSegments, applyErrataToText } from "../errata/errata-apply";
import type { ErrataRules } from "../errata/errata-apply";
import { extractTranscriptSegments } from "./note-transcript-ledger";
import {
  applyRoleMappingToSegments, extractRoleMappingFromFrontmatter, flattenRoleMappedFrontmatter,
  type RoleMapping,
} from "./role-mapping";

export interface RepolishInput {
  segments: Segment[];
  sessionMeta: Record<string, unknown>;
  originalFrontmatter: Record<string, unknown> | null;
  roleMapping: RoleMapping[];
}

function buildUtteranceProjections(segments: Segment[], mapping: RoleMapping[], errata?: ErrataRules | null): Array<{
  utteranceId: string;
  normalizedText: string;
  speakerName: string | null;
}> {
  const orderedMapping = [...mapping].sort((left, right) => right.from.length - left.from.length);
  return segments.flatMap((segment) => {
    if (!segment.transcript) return [];
    return getCurrentTranscript(segment.transcript).utterances.flatMap((utterance) => {
      let normalizedText = utterance.normalizedText;
      for (const item of orderedMapping) {
        if (item.from) normalizedText = normalizedText.split(item.from).join(item.to);
      }
      if (errata) normalizedText = applyErrataToText(normalizedText, errata).text;
      const speakerName = orderedMapping.find((item) => item.from === utterance.speakerName)?.to ?? utterance.speakerName;
      return normalizedText !== utterance.normalizedText || speakerName !== utterance.speakerName
        ? [{ utteranceId: utterance.id, normalizedText, speakerName: speakerName || null }]
        : [];
    });
  });
}

export function readRepolishInput(
  content: string,
  frontmatter: Record<string, unknown> | null,
  errata?: ErrataRules | null,
): RepolishInput {
  const roleMapping = extractRoleMappingFromFrontmatter(frontmatter);
  let segments = extractTranscriptSegments(content);
  if (roleMapping.length) segments = applyRoleMappingToSegments(segments, roleMapping);
  if (errata) segments = applyErrataToSegments(segments, errata);

  let sessionMeta: Record<string, unknown> = frontmatter
    ? readRepolishSessionTiming(frontmatter) || {}
    : {};
  sessionMeta = Object.assign({}, sessionMeta, {
    _previousKnowledge: readSessionKnowledge(content),
    _utteranceProjections: buildUtteranceProjections(extractTranscriptSegments(content), roleMapping, errata),
  });
  if (errata) {
    // The prompt and output pass share the same user-confirmed rule set.
    sessionMeta._errata = errata.prompt || "";
    sessionMeta._errataReplacements = [...errata.replacements];
  }
  return {
    segments,
    sessionMeta,
    originalFrontmatter: frontmatter ? flattenRoleMappedFrontmatter(frontmatter, roleMapping) : null,
    roleMapping,
  };
}
