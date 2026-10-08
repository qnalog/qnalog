import { t } from "../shared/i18n";
import { isLlmConfigError, isLlmServiceBlockedError } from "./failure-policy";

const stringifyIssue = String as (value: unknown) => string;

export function formatLlmConfigIssue(issue: unknown): string {
  const text = stringifyIssue(issue || "").trim();
  if (!text) return "";
  if (/请到「设置|Settings → API/.test(text)) return text;
  return t("{0}. Please complete it under Settings → API → AI organizing service, then test the connection.").replace("{0}", text);
}

export function formatLlmFailureIssue(issue: unknown): string {
  const text = stringifyIssue(issue || "").trim();
  if (!text) return "";
  if (isLlmConfigError(text)) return formatLlmConfigIssue(text);
  if (isLlmServiceBlockedError(text)) {
    return t("{0}. This is a problem returned by the LLM service or account pool, not caused by text length, ASR, or the text-import path; switch the model/endpoint, or retry manually later.").replace("{0}", text);
  }
  return text;
}
