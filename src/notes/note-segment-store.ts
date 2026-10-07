import * as obsidian from "obsidian";
import type { Vault } from "obsidian";
import type { RecordingSession } from "../shared/types";
import { nsMarker } from "../shared/namespace";
import { findNoteMarkerOffset, findSessionNoteBlock } from "./note-document";

export type NoteSegmentVault = Pick<Vault, "getAbstractFileByPath" | "read" | "modify" | "create">;

export interface NoteSegmentStoreHost {
  getVault(): NoteSegmentVault;
  appendToNote(path: string, content: string): Promise<void>;
}

export async function appendNoteText(host: NoteSegmentStoreHost, path: string, content: string): Promise<void> {
  const existing = host.getVault().getAbstractFileByPath(path);
  if (existing instanceof obsidian.TFile) {
    const cur = await host.getVault().read(existing);
    const sep = cur.endsWith("\n") ? "" : "\n";
    await host.getVault().modify(existing, cur + sep + content);
  } else {
    await host.getVault().create(path, content);
  }
}

export async function insertBeforeSessionSegmentsStart(
  host: NoteSegmentStoreHost,
  path: string,
  content: string,
  sessionId?: string | null,
): Promise<void> {
  const file = host.getVault().getAbstractFileByPath(path);
  if (!(file instanceof obsidian.TFile)) return host.appendToNote(path, content);
  const cur = await host.getVault().read(file);
  const marker = nsMarker("segments-start", sessionId || undefined);
  const idx = findNoteMarkerOffset(cur, marker, "first");
  if (idx >= 0) {
    const next = cur.slice(0, idx) + content + "\n" + cur.slice(idx);
    await host.getVault().modify(file, next);
    return;
  }
  await host.appendToNote(path, content);
}

export async function insertBeforeSessionSegmentsEnd(
  host: NoteSegmentStoreHost,
  path: string,
  content: string,
  sessionId?: string | null,
): Promise<void> {
  const file = host.getVault().getAbstractFileByPath(path);
  if (!(file instanceof obsidian.TFile)) return host.appendToNote(path, content);
  const cur = await host.getVault().read(file);
  const specific = sessionId ? nsMarker("segments-end", sessionId) : null;
  const legacy = nsMarker("segments-end");
  const specificIndex = specific ? findNoteMarkerOffset(cur, specific, "first") : -1;
  if (specific && specificIndex >= 0) {
    const next = cur.slice(0, specificIndex) + `${content}\n${specific}` + cur.slice(specificIndex + specific.length);
    await host.getVault().modify(file, next);
    return;
  }
  const lastIdx = findNoteMarkerOffset(cur, legacy, "last");
  if (lastIdx >= 0) {
    const next = cur.slice(0, lastIdx) + content + "\n" + cur.slice(lastIdx);
    await host.getVault().modify(file, next);
    return;
  }
  await host.appendToNote(path, content);
}

export async function removeSessionNoteBlock(
  host: NoteSegmentStoreHost,
  session: Pick<RecordingSession, "mdPath" | "id">,
): Promise<void> {
  const file = host.getVault().getAbstractFileByPath(session.mdPath);
  if (!(file instanceof obsidian.TFile)) return;
  const cur = await host.getVault().read(file);
  const range = findSessionNoteBlock(cur, session.id);
  if (!range) return;
  const before = cur.slice(0, range.start).replace(/\n+$/, "\n");
  const after = cur.slice(range.end).replace(/^\n+/, "");
  const next = before + (after ? "\n" + after : "");
  if (next !== cur) await host.getVault().modify(file, next);
}
