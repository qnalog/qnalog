import * as obsidian from "obsidian";
import { NS_MERGE_BLOCK_RE, NS_TAG, nsMarker } from "../shared/namespace";
import type { NoteMergeSourceMetadata } from "./note-merge-flow";

const MERGE_DETAILS_RE = /<details>\s*<summary>QnALog merge data<\/summary>[\s\S]*?qnalog-merge-end\s*-->\s*<\/details>/i;

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
  const block = `<details><summary>QnALog merge data</summary>${nsMarker("merge")}\n${JSON.stringify(payload, null, 2)}\n${NS_TAG}-merge-end --></details>`;
  const cur = await host.getVault().read(file);
  if (MERGE_DETAILS_RE.test(cur)) {
    await host.getVault().modify(file, cur.replace(MERGE_DETAILS_RE, () => block));
    return;
  }
  if (NS_MERGE_BLOCK_RE.test(cur)) {
    await host.getVault().modify(file, cur.replace(NS_MERGE_BLOCK_RE, () => block));
  } else {
    await host.getVault().modify(file, cur.replace(/\s*$/, () => "\n\n" + block + "\n"));
  }
}
