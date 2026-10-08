import { formatElapsed } from "../shared/util-common";

export interface SessionMasterAudioInput {
  masterAudioName?: unknown;
  masterAudioPath?: unknown;
}

export function getAudioTimeLink(audioName: unknown, ms?: number | null): string {
  const name = String((audioName as string) || "").trim();
  if (!name) return "";
  return `[[${name}|${formatElapsed(ms || 0)}]]`;
}

export function getSessionMasterAudioName(session: SessionMasterAudioInput | null | undefined): string {
  const name = String(session && session.masterAudioName ? session.masterAudioName as string : "").trim();
  if (name) return name;
  const path = String(session && session.masterAudioPath ? session.masterAudioPath as string : "").trim();
  return path ? (path.split("/").pop() || path) : "";
}
