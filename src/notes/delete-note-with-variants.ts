import * as obsidian from "obsidian";
import { NS_FM, deleteNamespaceFrontmatter, isDerivedVersionType, readNamespaceFrontmatter, setNamespaceFrontmatter } from "../shared/namespace";

export interface DeletableNoteFile {
  path: string;
  basename: string;
  stat?: { mtime?: number } | null;
}

export interface NoteVariantSnapshot<TFile extends DeletableNoteFile = DeletableNoteFile> {
  file: TFile;
  content: string;
  sourcePath: string;
  kind: string;
  label: string;
}

export interface DeleteNoteWithVariantsPort<TFile extends DeletableNoteFile> {
  listMarkdownFiles(): readonly TFile[];
  readFile(file: TFile): Promise<string>;
  updateFrontmatter(file: TFile, update: (frontmatter: Record<string, unknown>) => void): Promise<void>;
  trashFile(file: TFile): Promise<void>;
}

export type DeleteNoteWithVariantsResult = "deleted" | "handed-off" | "stale";

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  try {
    const parsed: unknown = obsidian.parseYaml(match[1]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

async function findVariants<TFile extends DeletableNoteFile>(
  port: DeleteNoteWithVariantsPort<TFile>, source: TFile,
): Promise<NoteVariantSnapshot<TFile>[]> {
  const sourcePath = normalizePath(source.path);
  const variants: NoteVariantSnapshot<TFile>[] = [];
  for (const file of port.listMarkdownFiles()) {
    if (normalizePath(file.path) === sourcePath || !/\.md$/i.test(file.path)) continue;
    const content = await port.readFile(file);
    const frontmatter = parseFrontmatter(content);
    const linkedSourcePath = readNamespaceFrontmatter(frontmatter, "sourcePath");
    if (typeof linkedSourcePath !== "string" || normalizePath(linkedSourcePath) !== sourcePath) continue;
    if (!isDerivedVersionType(readNamespaceFrontmatter(frontmatter, "type"))
      && readNamespaceFrontmatter(frontmatter, "containsRaw") !== false) continue;
    variants.push({
      file,
      content,
      sourcePath: normalizePath(linkedSourcePath),
      kind: typeof frontmatter[NS_FM.variantKind] === "string" ? frontmatter[NS_FM.variantKind] as string : "",
      label: typeof frontmatter.variant_label === "string" && frontmatter.variant_label ? frontmatter.variant_label : file.basename,
    });
  }
  return variants.sort((a, b) => (a.file.stat?.mtime || 0) - (b.file.stat?.mtime || 0));
}

export async function getDirectNoteVariants<TFile extends DeletableNoteFile>(
  port: DeleteNoteWithVariantsPort<TFile>, source: TFile,
): Promise<NoteVariantSnapshot<TFile>[]> {
  return findVariants(port, source);
}

async function snapshotsStillMatch<TFile extends DeletableNoteFile>(
  port: DeleteNoteWithVariantsPort<TFile>, source: TFile, expected: readonly NoteVariantSnapshot<TFile>[],
): Promise<boolean> {
  const current = await findVariants(port, source);
  if (current.length !== expected.length) return false;
  return current.every((variant, index) => variant.file.path === expected[index].file.path
    && variant.content === expected[index].content);
}

export async function deleteNoteWithVariants<TFile extends DeletableNoteFile>(options: {
  port: DeleteNoteWithVariantsPort<TFile>;
  source: TFile;
  expectedVariants: readonly NoteVariantSnapshot<TFile>[];
  action: "handoff" | "delete-all";
}): Promise<DeleteNoteWithVariantsResult> {
  const { port, source, expectedVariants, action } = options;
  if (!await snapshotsStillMatch(port, source, expectedVariants)) return "stale";
  if (action === "delete-all") {
    for (const variant of expectedVariants) await port.trashFile(variant.file);
    await port.trashFile(source);
    return "deleted";
  }

  const latest = expectedVariants[expectedVariants.length - 1];
  if (!latest) {
    await port.trashFile(source);
    return "deleted";
  }
  for (const variant of expectedVariants) {
    if (variant.file.path === latest.file.path) {
      await port.updateFrontmatter(variant.file, (frontmatter) => {
        setNamespaceFrontmatter(frontmatter, "promotedVariant", true);
        deleteNamespaceFrontmatter(frontmatter, "type");
        deleteNamespaceFrontmatter(frontmatter, "sourcePath");
        deleteNamespaceFrontmatter(frontmatter, "sourceId");
        deleteNamespaceFrontmatter(frontmatter, "variantKind");
        delete frontmatter.variant_kind;
        delete frontmatter.variant_label;
        delete frontmatter.variant_mode;
        delete frontmatter.variant_style;
      });
    } else {
      await port.updateFrontmatter(variant.file, (frontmatter) => {
        setNamespaceFrontmatter(frontmatter, "sourcePath", latest.file.path);
      });
    }
  }
  await port.trashFile(source);
  return "handed-off";
}
