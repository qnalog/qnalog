import * as obsidian from "obsidian";
import { NS_MERGE_BLOCK_RE, NS_TAG, nsMarker } from "../shared/namespace";
import type { NoteMergeSourceMetadata } from "./note-merge-flow";

export type NoteMergeMetadataVault = Pick<obsidian.Vault, "read" | "modify">;

export interface NoteMergeMetadataStoreHost {
  getVault(): NoteMergeMetadataVault;
}

export async function writeMergeMetadataBlock(
  host: NoteMergeMetadataStoreHost,
  file: unknown,
  sources: readonly NoteMergeSourceMetadata[] | null | undefined,
): Promise<void> {
  if (!(file instanceof obsidian.TFile)) return;
  const payload = {
    mergedAt: new Date().toISOString(),
    sources: (sources || []).map((source) => ({
      path: source.path || "",
      title: source.title || "",
      durationMs: Number(source.durationMs) || 0,
    })),
  };
  const block = `${nsMarker("merge")}\n${JSON.stringify(payload, null, 2)}\n${NS_TAG}-merge-end -->`;
  const cur = await host.getVault().read(file);
  if (NS_MERGE_BLOCK_RE.test(cur)) {
    await host.getVault().modify(file, cur.replace(NS_MERGE_BLOCK_RE, () => block));
  } else {
    await host.getVault().modify(file, cur.replace(/\s*$/, () => "\n\n" + block + "\n"));
  }
}
