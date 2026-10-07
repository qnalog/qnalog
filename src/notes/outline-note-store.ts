import * as obsidian from "obsidian";
import type { DataAdapter, TFile, Vault } from "obsidian";
import { iterateNoteDetailsBlocks } from "./note-document";
import { readCurrentOutlineBlock } from "./outline-storage";
import { NS_OUTLINE_BACKUP_FOLDER } from "../shared/namespace";
import { labelPattern } from "../shared/note-labels";

export type OutlineNoteVault = Pick<Vault, "read" | "process" | "configDir"> & {
  readonly adapter?: Pick<DataAdapter, "exists" | "mkdir" | "write" | "read">;
};

export interface OutlineNoteStoreHost {
  getVault(): OutlineNoteVault;
}

export type RealtimeOutlineReplacementResult =
  | { status: "written"; backupPath: string }
  | { status: "stale" | "backup-failed" | "write-failed"; backupPath: string | null; errorMessage?: string };

export async function replaceRealtimeOutlineNote(
  host: OutlineNoteStoreHost,
  file: TFile,
  expectedMarkdown: string,
  outlineDetails: string,
): Promise<RealtimeOutlineReplacementResult> {
  const vault = host.getVault();
  const generatedOutlineBlock = readCurrentOutlineBlock(outlineDetails);
  if (!(file instanceof obsidian.TFile) || file.extension !== "md" || !generatedOutlineBlock
    || generatedOutlineBlock.range.start !== 0 || generatedOutlineBlock.range.end !== outlineDetails.length) {
    return { status: "write-failed", backupPath: null, errorMessage: "Invalid outline replacement target or details block" };
  }

  let currentMarkdown: string;
  try {
    currentMarkdown = await vault.read(file);
  } catch (error) {
    return { status: "write-failed", backupPath: null, errorMessage: error instanceof Error ? error.message : String(error) };
  }
  if (currentMarkdown !== expectedMarkdown) return { status: "stale", backupPath: null };

  const replacement = replaceCurrentOutlineDetails(expectedMarkdown, outlineDetails);
  if (replacement == null) return { status: "write-failed", backupPath: null, errorMessage: "Could not place the outline details block" };

  let backupPath: string;
  try {
    backupPath = await backupOutlineSource(host, file, expectedMarkdown);
  } catch (error) {
    return { status: "backup-failed", backupPath: null, errorMessage: error instanceof Error ? error.message : String(error) };
  }

  let staleDuringProcess = false;
  try {
    await vault.process(file, (content) => {
      if (content !== expectedMarkdown) {
        staleDuringProcess = true;
        return content;
      }
      return replacement;
    });
  } catch (error) {
    return {
      status: "write-failed",
      backupPath,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
  if (staleDuringProcess) return { status: "stale", backupPath };

  try {
    const readback = await vault.read(file);
    if (readback !== replacement) {
      return { status: "write-failed", backupPath, errorMessage: "Outline replacement readback did not match" };
    }
  } catch (error) {
    return {
      status: "write-failed",
      backupPath,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
  return { status: "written", backupPath };
}

function replaceCurrentOutlineDetails(markdown: string, outlineDetails: string): string | null {
  const text = String(markdown || "");
  const current = readCurrentOutlineBlock(text);
  if (current) {
    return text.slice(0, current.range.start) + outlineDetails + text.slice(current.range.end);
  }

  let recordingInfoRange: { start: number; end: number } | null = null;
  for (const range of iterateNoteDetailsBlocks(text)) {
    const summary = text.slice(range.summaryStart, range.summaryEnd).replace(/<[^>]*>/g, "").trim();
    if (labelPattern("recordingInfo").test(summary)) recordingInfoRange = range;
  }
  const insertAt = recordingInfoRange ? recordingInfoRange.end : text.length;
  const before = text.slice(0, insertAt);
  const after = text.slice(insertAt);
  const beforeSeparator = !before
    ? ""
    : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const afterSeparator = !after
    ? ""
    : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return `${before}${beforeSeparator}${outlineDetails}${afterSeparator}${after}`;
}

async function backupOutlineSource(
  host: OutlineNoteStoreHost,
  file: TFile,
  originalMarkdown: string,
): Promise<string> {
  const vault = host.getVault();
  const adapter = vault.adapter;
  if (!adapter) throw new Error("Vault storage adapter is unavailable");
  const configDir = obsidian.normalizePath(String(vault.configDir || "").trim());
  const backupRoot = obsidian.normalizePath(`${configDir ? `${configDir}/` : ""}${NS_OUTLINE_BACKUP_FOLDER}`);
  if (!(await adapter.exists(backupRoot))) await adapter.mkdir(backupRoot);
  if (!(await adapter.exists(backupRoot))) throw new Error("Could not create the outline backup folder");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const timestampFolder = obsidian.normalizePath(`${backupRoot}/${timestamp}${suffix}`);
    if (await adapter.exists(timestampFolder)) continue;
    try {
      await adapter.mkdir(timestampFolder);
    } catch (error) {
      if (!(await adapter.exists(timestampFolder))) throw error;
      continue;
    }
    const backupPath = obsidian.normalizePath(`${timestampFolder}/${file.name}`);
    if (await adapter.exists(backupPath)) continue;
    await adapter.write(backupPath, originalMarkdown);
    if (await adapter.read(backupPath) !== originalMarkdown) {
      throw new Error("Outline backup readback did not match the original note");
    }
    return backupPath;
  }
  throw new Error("Could not allocate a unique outline backup timestamp");
}
