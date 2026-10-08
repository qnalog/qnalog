import * as obsidian from "obsidian";
import { primitiveText } from "../shared/util-common";

export type MeetingMaterial = {
  path: string;
  name: string;
  kind: string;
  addedAt: string;
};

export type MeetingInteraction = {
  kind: string;
  query: string;
  status: string;
  response: string;
  error: string;
  updatedAt: string;
  assignee?: string;
  task?: string;
};

export type MeetingWorkbenchEntry = {
  id: string;
  atMs: number;
  createdAt: string;
  source: string;
  text: string;
  materials: MeetingMaterial[];
  interaction: MeetingInteraction | null;
};

export type MeetingWorkbenchState = {
  notes: string;
  draft: string;
  materials: MeetingMaterial[];
  entries: MeetingWorkbenchEntry[];
};

export function normalizeMeetingMaterials(materials: unknown, limit = 30): MeetingMaterial[] {
  const normalized: MeetingMaterial[] = [];
  const seen = new Set<string>();
  for (const item of (Array.isArray(materials) ? materials : []) as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const path = obsidian.normalizePath((row.path as string) || "");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    normalized.push({
      path,
      name: String((row.name as string) || path.split("/").pop() || "").trim(),
      kind: String((row.kind as string) || (row.type as string) || "").trim(),
      addedAt: String((row.addedAt as string) || ""),
    });
  }
  return normalized.slice(-limit);
}

export function normalizeMeetingWorkbench(value: unknown): MeetingWorkbenchState {
  const raw: Record<string, unknown> = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const entries: MeetingWorkbenchEntry[] = [];
  for (const item of (Array.isArray(raw.entries) ? raw.entries : []) as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const text = String((row.text as string) || "").trim();
    const materials = normalizeMeetingMaterials(row.materials, 12);
    if (!text && !materials.length) continue;
    const createdAt = String((row.createdAt as string) || (row.addedAt as string) || "");
    const atMs = Math.max(0, Number(row.atMs ?? row.offsetMs ?? 0) || 0);
    const rawInteraction = row.interaction && typeof row.interaction === "object"
      ? row.interaction as Record<string, unknown>
      : null;
    const interaction = rawInteraction ? {
      kind: String((rawInteraction.kind as string) || "").trim(),
      query: String((rawInteraction.query as string) || "").trim(),
      status: String((rawInteraction.status as string) || "").trim(),
      response: String((rawInteraction.response as string) || "").trim(),
      error: String((rawInteraction.error as string) || "").trim(),
      updatedAt: String((rawInteraction.updatedAt as string) || ""),
      assignee: String((rawInteraction.assignee as string) || "").trim(),
      task: String((rawInteraction.task as string) || "").trim(),
    } : null;
    entries.push({
      id: String((row.id as string) || `meeting-entry-${entries.length}-${atMs}-${createdAt || "time"}`),
      atMs,
      createdAt,
      source: String((row.source as string) || (materials.length && !text ? "material" : "manual")),
      text,
      materials,
      interaction,
    });
  }
  return {
    notes: primitiveText(raw.notes).trim(),
    draft: primitiveText(raw.draft),
    materials: normalizeMeetingMaterials(raw.materials, 30),
    entries: entries.slice(-100),
  };
}

export function hasMeetingWorkbenchContent(value: unknown): boolean {
  const workbench = normalizeMeetingWorkbench(value);
  return !!(workbench.notes || workbench.materials.length || workbench.entries.length);
}

export function isImageMeetingMaterial(item: unknown): boolean {
  const material = item as { path?: string; kind?: string } | null | undefined;
  const path = String((material && material.path) || "").toLowerCase();
  const kind = String((material && material.kind) || "").toLowerCase();
  return kind === "image" || /\.(png|jpe?g|webp|gif|bmp|svg)$/.test(path);
}
