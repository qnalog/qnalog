import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/restore-from-backup.mjs", import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface RestoreFixture {
  root: string;
  backup: string;
  vault: string;
  config: string;
  plugins: string;
  outside: string;
  id: string;
}

function fixture(id = "qnalog") {
  const root = mkdtempSync(path.join(os.tmpdir(), "qnalog-restore-"));
  roots.push(root);
  const backup = path.join(root, "snapshot");
  const vault = path.join(root, "vault");
  const outside = path.join(root, "outside");
  const config = path.join(vault, ".obsidian");
  const plugins = path.join(config, "plugins");
  mkdirSync(backup, { recursive: true });
  mkdirSync(plugins, { recursive: true });
  for (const id of ["other-a", "other-b"]) {
    const pluginDir = path.join(plugins, id);
    mkdirSync(path.join(pluginDir, "cache"), { recursive: true });
    writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({ id, version: "stable" }));
    writeFileSync(path.join(pluginDir, "main.js"), `${id}-main`);
    writeFileSync(path.join(pluginDir, "data.json"), `${id}-data`);
    writeFileSync(path.join(pluginDir, "cache", "nested.bin"), `${id}-cache`);
  }
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(backup, "manifest.json"), JSON.stringify({ id, version: "1.2.3" }));
  writeFileSync(path.join(backup, "main.js"), "backup-main-bytes");
  writeFileSync(path.join(backup, "styles.css"), "backup-style-bytes");
  writeFileSync(path.join(backup, "data.json"), "backup-data-bytes");
  mkdirSync(path.join(backup, "cache"));
  writeFileSync(path.join(backup, "cache", "nested.bin"), "backup-cache-bytes");
  writeFileSync(path.join(outside, "sentinel"), "outside-sentinel");
  writeFileSync(path.join(config, "community-plugins.json"), '["other-a", "qnalog", "other-b"]\n');
  writeFileSync(path.join(config, "app.json"), "settings-stay-byte-identical\n");
  return { root, backup, vault, config, plugins, outside, id };
}

function run(f: RestoreFixture, source = f.backup, flags: string[] = []) {
  return spawnSync(process.execPath, [script, source, f.vault, ...flags], {
    cwd: f.root,
    encoding: "utf8",
    env: { ...process.env, QNALOG_VAULT: "" },
  });
}

function treeSnapshot(root: string): string[] {
  if (!existsLstat(root)) return [];
  const records: string[] = [];
  const visit = (current: string, relative: string) => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      records.push(`${relative}:link:${readlinkSync(current)}`);
    } else if (stat.isDirectory()) {
      records.push(`${relative}:dir`);
      for (const name of readdirSync(current).sort()) visit(path.join(current, name), path.join(relative, name));
    } else if (stat.isFile()) {
      records.push(`${relative}:file:${readFileSync(current).toString("base64")}`);
    } else {
      records.push(`${relative}:other:${stat.mode}`);
    }
  };
  visit(root, ".");
  return records;
}

function existsLstat(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function createFixtureLink(create: () => void): "EPERM" | "EACCES" | "ENOSYS" | null {
  try {
    create();
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "ENOSYS")) return code;
    throw error;
  }
}


function seedTarget(f: RestoreFixture, id = f.id) {
  const target = path.join(f.plugins, id);
  mkdirSync(path.join(target, "cache"), { recursive: true });
  writeFileSync(path.join(target, "manifest.json"), JSON.stringify({ id, version: "old" }));
  writeFileSync(path.join(target, "main.js"), "old-main-bytes");
  writeFileSync(path.join(target, "data.json"), "old-data-bytes");
  writeFileSync(path.join(target, "old-extra.txt"), "kept-by-copy-merge");
  writeFileSync(path.join(target, "cache", "nested.bin"), "old-cache-bytes");
  return target;
}

function unchangedFailure(f: RestoreFixture, source = f.backup, flags: string[] = []) {
  const before = treeSnapshot(f.root);
  const result = run(f, source, flags);
  expect(result.status).toBe(1);
  expect(treeSnapshot(f.root)).toEqual(before);
  return result;
}

const invalidIds: unknown[] = [
  null, 7, "", ".", "..", "../outside", "../../outside",
  "..\\outside", "C:\\outside", "C:outside", "\\\\server\\share",
  "bad\u0000id", "bad\u001fid", "bad\u007fid", "bad<id", "bad>id", 'bad"id', "bad|id", "bad?id", "bad*id",
  " leading", "trailing ", "trailing.", "CON", "con.txt", "PRN", "AUX.log", "NUL", "COM1", "com9.ext", "LPT1", "lpt9.txt",
  {}, [], true,
];

describe("restore-from-backup CLI path boundary", () => {
  it.each(invalidIds)("rejects unsafe manifest id %s before any write", id => {
    const f = fixture("qnalog");
    seedTarget(f, "qnalog");
    writeFileSync(path.join(f.backup, "manifest.json"), JSON.stringify({ id, version: "x" }));
    unchangedFailure(f);
  });

  it.each(process.platform === "win32" ? ["POSIX-ABS", "WIN-ABS"] : ["POSIX-ABS"])("rejects fixture-local %s absolute id", kind => {
    const f = fixture("qnalog");
    seedTarget(f, "qnalog");
    const posixAbsoluteId = f.outside.replace(/^[A-Za-z]:/, "").replace(/\\/g, "/");
    const id = kind === "POSIX-ABS" ? posixAbsoluteId : f.outside;
    writeFileSync(path.join(f.backup, "manifest.json"), JSON.stringify({ id }));
    unchangedFailure(f);
  });

  it.each(["../outside", "../../outside"])("rejects traversal %s even when enabled-list rewriting is requested", id => {
    const f = fixture(id);
    seedTarget(f, "qnalog");
    for (const outsidePath of [path.join(f.config, "outside"), path.join(f.vault, "outside")]) {
      mkdirSync(outsidePath, { recursive: true });
      writeFileSync(path.join(outsidePath, "main.js"), `${outsidePath}-main`);
      writeFileSync(path.join(outsidePath, "data.json"), `${outsidePath}-data`);
    }
    unchangedFailure(f, f.backup, ["--set-enabled"]);
  });

  it("restores a qnalog snapshot, preserving the full old target and unrelated bytes", () => {
    const f = fixture("qnalog");
    const target = seedTarget(f);
    const oldTarget = treeSnapshot(target);
    const sourceBefore = treeSnapshot(f.backup);
    const othersBefore = ["other-a", "other-b"].map(id => treeSnapshot(path.join(f.plugins, id)));
    const enabledBefore = readFileSync(path.join(f.config, "community-plugins.json"));
    const appBefore = readFileSync(path.join(f.config, "app.json"));
    const result = run(f);
    expect(result.status).toBe(0);
    for (const name of ["manifest.json", "main.js", "styles.css", "data.json", "cache/nested.bin"]) {
      expect(readFileSync(path.join(target, name))).toEqual(readFileSync(path.join(f.backup, name)));
    }
    expect(readFileSync(path.join(target, "old-extra.txt"), "utf8")).toBe("kept-by-copy-merge");
    const safetyRoot = path.join(f.config, "qnalog-install-backups");
    const safetyNames = readdirSync(safetyRoot);
    expect(safetyNames).toHaveLength(1);
    expect(safetyNames[0]).toMatch(/^\d{14}-before-restore$/);
    expect(treeSnapshot(path.join(safetyRoot, safetyNames[0]))).toEqual(oldTarget);
    expect(treeSnapshot(f.backup)).toEqual(sourceBefore);
    expect(["other-a", "other-b"].map(id => treeSnapshot(path.join(f.plugins, id)))).toEqual(othersBefore);
    expect(readFileSync(path.join(f.config, "community-plugins.json"))).toEqual(enabledBefore);
    expect(readFileSync(path.join(f.config, "app.json"))).toEqual(appBefore);
  });

  it("restores dotted, underscored, and Unicode ids with full payload bytes", () => {
    for (const id of ["some-plugin", "some_plugin", "plugin.v2", "插件"]) {
      const f = fixture(id);
      const sourceBefore = treeSnapshot(f.backup);
      const othersBefore = ["other-a", "other-b"].map(otherId => treeSnapshot(path.join(f.plugins, otherId)));
      const result = run(f);
      expect(result.status).toBe(0);
      const target = path.join(f.plugins, id);
      for (const name of ["manifest.json", "main.js", "styles.css", "data.json", "cache/nested.bin"]) {
        expect(readFileSync(path.join(target, name))).toEqual(readFileSync(path.join(f.backup, name)));
      }
      expect(readdirSync(f.plugins).sort()).toEqual(["other-a", "other-b", id].sort());
      expect(treeSnapshot(f.backup)).toEqual(sourceBefore);
      expect(["other-a", "other-b"].map(otherId => treeSnapshot(path.join(f.plugins, otherId)))).toEqual(othersBefore);
    }
  });

  it("creates a missing plugins root and restores the complete source payload", () => {
    const f = fixture("qnalog");
    const sourceBefore = treeSnapshot(f.backup);
    rmSync(f.plugins, { recursive: true });
    const result = run(f);
    expect(result.status).toBe(0);
    for (const name of ["manifest.json", "main.js", "styles.css", "data.json", "cache/nested.bin"]) {
      expect(readFileSync(path.join(f.plugins, "qnalog", name))).toEqual(readFileSync(path.join(f.backup, name)));
    }
    expect(treeSnapshot(f.backup)).toEqual(sourceBefore);
    expect(existsLstat(path.join(f.config, "qnalog-install-backups"))).toBe(false);
  });

  it("updates and backs up the enabled list only when the requested change is needed", () => {
    const f = fixture("foreign_plugin.v2");
    const target = seedTarget(f, "qnalog");
    const enabledPath = path.join(f.config, "community-plugins.json");
    const oldEnabled = readFileSync(enabledPath);
    const sourceBefore = treeSnapshot(f.backup);
    const targetBefore = treeSnapshot(target);
    const othersBefore = ["other-a", "other-b"].map(id => treeSnapshot(path.join(f.plugins, id)));
    const result = run(f, f.backup, ["--set-enabled"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(enabledPath, "utf8"))).toEqual(["other-a", "other-b", f.id]);
    const backups = readdirSync(f.config).filter(name => name.startsWith("community-plugins.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(f.config, backups[0]))).toEqual(oldEnabled);
    const restored = path.join(f.plugins, f.id);
    for (const name of ["manifest.json", "main.js", "styles.css", "data.json", "cache/nested.bin"]) {
      expect(readFileSync(path.join(restored, name))).toEqual(readFileSync(path.join(f.backup, name)));
    }
    expect(treeSnapshot(target)).toEqual(targetBefore);
    expect(treeSnapshot(f.backup)).toEqual(sourceBefore);
    expect(["other-a", "other-b"].map(id => treeSnapshot(path.join(f.plugins, id)))).toEqual(othersBefore);
    const f2 = fixture("already-enabled");
    const exactEnabled = '[  \n  "already-enabled"   \n]\n';
    writeFileSync(path.join(f2.config, "community-plugins.json"), exactEnabled);
    expect(run(f2, f2.backup, ["--set-enabled"]).status).toBe(0);
    expect(readFileSync(path.join(f2.config, "community-plugins.json"), "utf8")).toBe(exactEnabled);
    expect(readdirSync(f2.config).some(name => name.startsWith("community-plugins.json.bak-"))).toBe(false);
  });

  it.each(["plugins-root", "obsidian-root", "backup-root", "target-dir", "target-file", "backup-nested"]) (
    "rejects linked %s without changing either side", (kind, context) => {
      const f = fixture();
      const linked = path.join(f.outside, "linked");
      let unavailable: "EPERM" | "EACCES" | "ENOSYS" | null = null;
      if (kind === "plugins-root") {
        mkdirSync(path.join(linked, "qnalog"), { recursive: true });
        writeFileSync(path.join(linked, "qnalog", "manifest.json"), '{"id":"qnalog"}');
        writeFileSync(path.join(linked, "qnalog", "main.js"), "outside-plugin-main");
        writeFileSync(path.join(linked, "qnalog", "data.json"), "outside-plugin-data");
        rmSync(f.plugins, { recursive: true });
        unavailable = createFixtureLink(() => symlinkSync(linked, f.plugins, "dir"));
      } else if (kind === "obsidian-root") {
        const outsideConfig = path.join(f.root, "outside-config");
        mkdirSync(path.join(outsideConfig, "plugins", "qnalog"), { recursive: true });
        writeFileSync(path.join(outsideConfig, "plugins", "qnalog", "manifest.json"), '{"id":"qnalog"}');
        writeFileSync(path.join(outsideConfig, "plugins", "qnalog", "main.js"), "outside-main");
        mkdirSync(path.join(outsideConfig, "plugins", "qnalog", "cache"), { recursive: true });
        writeFileSync(path.join(outsideConfig, "plugins", "qnalog", "cache", "nested.bin"), "outside-config-cache");
        rmSync(f.config, { recursive: true });
        unavailable = createFixtureLink(() => symlinkSync(outsideConfig, f.config, "dir"));
      } else if (kind === "backup-root") {
        seedTarget(f);
        mkdirSync(path.join(linked, "nested"), { recursive: true });
        writeFileSync(path.join(linked, "nested", "sentinel"), "outside-backup-root");
        unavailable = createFixtureLink(() => symlinkSync(linked, path.join(f.config, "qnalog-install-backups"), "dir"));
      } else if (kind === "target-dir") {
        mkdirSync(linked);
        writeFileSync(path.join(linked, "main.js"), "sentinel");
        unavailable = createFixtureLink(() => symlinkSync(linked, path.join(f.plugins, "qnalog"), "dir"));
      } else if (kind === "target-file") {
        const target = seedTarget(f);
        writeFileSync(linked, "outside-linked-file");
        unavailable = createFixtureLink(() => symlinkSync(linked, path.join(target, "styles.css")));
      } else {
        writeFileSync(linked, "outside-linked-backup-entry");
        unavailable = createFixtureLink(() => symlinkSync(linked, path.join(f.backup, "cache", "linked")));
      }
      if (unavailable) context.skip(`link creation failed with ${unavailable}`);
      unchangedFailure(f);
    },
  );

  it.each(["source", "target"])("rejects a dangling %s descendant before any write", (side, context) => {
    const f = fixture("qnalog");
    const target = seedTarget(f);
    const missing = path.join(f.outside, side === "source" ? "missing-source-child" : "missing-target-file");
    const unavailable = side === "source"
      ? createFixtureLink(() => symlinkSync(missing, path.join(f.backup, "cache", "linked"), "dir"))
      : createFixtureLink(() => symlinkSync(missing, path.join(target, "styles.css")));
    if (unavailable) context.skip(`link creation failed with ${unavailable}`);
    unchangedFailure(f);
  });

  it("rejects a dangling target link without creating a safety snapshot", (context) => {
    const f = fixture("qnalog");
    const unavailable = createFixtureLink(() => symlinkSync(path.join(f.outside, "missing-target"), path.join(f.plugins, "qnalog"), "dir"));
    if (unavailable) context.skip(`link creation failed with ${unavailable}`);
    unchangedFailure(f);
  });

  it("allows root arguments that are symlink aliases to the same ordinary directories", (context) => {
    const f = fixture("qnalog");
    const backupAlias = path.join(f.root, "backup-alias");
    const vaultAlias = path.join(f.root, "vault-alias");
    let unavailable = createFixtureLink(() => symlinkSync(f.backup, backupAlias, "dir"));
    if (unavailable) context.skip(`link creation failed with ${unavailable}`);
    unavailable = createFixtureLink(() => symlinkSync(f.vault, vaultAlias, "dir"));
    if (unavailable) context.skip(`link creation failed with ${unavailable}`);
    const sourceBefore = treeSnapshot(f.backup);
    const othersBefore = ["other-a", "other-b"].map(id => treeSnapshot(path.join(f.plugins, id)));
    const result = spawnSync(process.execPath, [script, backupAlias, vaultAlias], {
      cwd: f.root, encoding: "utf8", env: { ...process.env, QNALOG_VAULT: "" },
    });
    expect(result.status).toBe(0);
    for (const name of ["manifest.json", "main.js", "styles.css", "data.json", "cache/nested.bin"]) {
      expect(readFileSync(path.join(f.plugins, "qnalog", name))).toEqual(readFileSync(path.join(f.backup, name)));
    }
    expect(treeSnapshot(f.backup)).toEqual(sourceBefore);
    expect(["other-a", "other-b"].map(id => treeSnapshot(path.join(f.plugins, id)))).toEqual(othersBefore);
  });

  it.each(["target-file", "target-dir", "source-file", "source-dir"])(
    "rejects readable %s links without changing their referents", (kind, context) => {
      const f = fixture("qnalog");
      const target = seedTarget(f);
      const linkedFile = path.join(f.outside, "referent-file");
      const linkedDir = path.join(f.outside, "referent-dir");
      mkdirSync(linkedDir);
      writeFileSync(linkedFile, "readable-outside-file");
      writeFileSync(path.join(linkedDir, "nested.bin"), "readable-outside-directory");
      let unavailable: "EPERM" | "EACCES" | "ENOSYS" | null = null;
      if (kind === "target-file") {
        unavailable = createFixtureLink(() => symlinkSync(linkedFile, path.join(target, "styles.css")));
      } else if (kind === "target-dir") {
        rmSync(path.join(target, "cache"), { recursive: true });
        unavailable = createFixtureLink(() => symlinkSync(linkedDir, path.join(target, "cache"), "junction"));
      } else if (kind === "source-file") {
        rmSync(path.join(f.backup, "styles.css"));
        unavailable = createFixtureLink(() => symlinkSync(linkedFile, path.join(f.backup, "styles.css")));
      } else {
        rmSync(path.join(f.backup, "cache"), { recursive: true });
        unavailable = createFixtureLink(() => symlinkSync(linkedDir, path.join(f.backup, "cache"), "dir"));
      }
      if (unavailable) context.skip(`link creation failed with ${unavailable}`);
      unchangedFailure(f);
    },
  );

  it("restores from a normal prior install backup and keeps that source untouched", () => {
    const f = fixture("qnalog");
    const target = seedTarget(f);
    const oldTarget = treeSnapshot(target);
    const backupRoot = path.join(f.config, "qnalog-install-backups");
    const source = path.join(backupRoot, "20000101000000");
    mkdirSync(backupRoot, { recursive: true });
    renameSync(f.backup, source);
    const sourceBefore = treeSnapshot(source);
    const result = run(f, source);
    expect(result.status).toBe(0);
    for (const name of ["manifest.json", "main.js", "styles.css", "data.json", "cache/nested.bin"]) {
      expect(readFileSync(path.join(target, name))).toEqual(readFileSync(path.join(source, name)));
    }
    expect(treeSnapshot(source)).toEqual(sourceBefore);
    const safetyNames = readdirSync(backupRoot).filter(name => name.endsWith("-before-restore"));
    expect(safetyNames).toHaveLength(1);
    expect(treeSnapshot(path.join(backupRoot, safetyNames[0]))).toEqual(oldTarget);
    expect(readdirSync(backupRoot).sort()).toEqual(["20000101000000", safetyNames[0]].sort());
  });

  it("rejects the backup root as source before creating an overlapping safety copy", () => {
    const f = fixture("qnalog");
    seedTarget(f);
    const backupRoot = path.join(f.config, "qnalog-install-backups");
    mkdirSync(backupRoot);
    writeFileSync(path.join(backupRoot, "manifest.json"), '{"id":"qnalog"}');
    writeFileSync(path.join(backupRoot, "main.js"), "backup-root-source");
    writeFileSync(path.join(backupRoot, "data.json"), "backup-root-data");
    unchangedFailure(f, backupRoot);
  });
  it.each(["same", "backup-inside-target", "target-inside-backup"])("rejects overlapping %s trees before copying", relation => {
    const f = fixture("qnalog");
    const target = seedTarget(f);
    let source = f.backup;
    if (relation === "same") {
      const samePath = path.join(f.plugins, "snapshot");
      mkdirSync(samePath);
      writeFileSync(path.join(samePath, "manifest.json"), '{"id":"snapshot"}');
      writeFileSync(path.join(samePath, "main.js"), "source");
      source = samePath;
    } else if (relation === "backup-inside-target") {
      source = path.join(target, "snapshot");
      mkdirSync(source);
      writeFileSync(path.join(source, "manifest.json"), '{"id":"qnalog"}');
      writeFileSync(path.join(source, "main.js"), "source");
    } else {
      source = f.plugins;
      writeFileSync(path.join(source, "manifest.json"), '{"id":"qnalog"}');
      writeFileSync(path.join(source, "main.js"), "source");
    }
    unchangedFailure(f, source);
  });

  it("rejects shared-inode target and enabled files before mutation", (context) => {
    const f = fixture("qnalog");
    const target = seedTarget(f);
    let unavailable = createFixtureLink(() => linkSync(path.join(target, "main.js"), path.join(f.outside, "hardlink-main")));
    if (unavailable) context.skip(`hardlink creation failed with ${unavailable}`);
    unchangedFailure(f);

    const f2 = fixture("new-id");
    unavailable = createFixtureLink(() => linkSync(path.join(f2.config, "community-plugins.json"), path.join(f2.outside, "enabled-hardlink")));
    if (unavailable) context.skip(`hardlink creation failed with ${unavailable}`);
    unchangedFailure(f2, f2.backup, ["--set-enabled"]);
  });

  it("rejects an enabled-list symlink when a requested write would follow it", (context) => {
    const f = fixture("new-id");
    const enabled = path.join(f.config, "community-plugins.json");
    rmSync(enabled);
    const enabledTarget = path.join(f.outside, "enabled-list.json");
    writeFileSync(enabledTarget, '["other-a"]');
    const unavailable = createFixtureLink(() => symlinkSync(enabledTarget, enabled));
    if (unavailable) context.skip(`link creation failed with ${unavailable}`);
    unchangedFailure(f, f.backup, ["--set-enabled"]);
  });

  it("leaves a valid enabled-list symlink untouched when no flag requests a write", (context) => {
    const f = fixture("new-id");
    const enabled = path.join(f.config, "community-plugins.json");
    const enabledTarget = path.join(f.outside, "enabled-list.json");
    const enabledBytes = '["other-a"]';
    writeFileSync(enabledTarget, enabledBytes);
    rmSync(enabled);
    const unavailable = createFixtureLink(() => symlinkSync(enabledTarget, enabled));
    if (unavailable) context.skip(`link creation failed with ${unavailable}`);
    const linkBefore = readlinkSync(enabled);
    const result = run(f);
    expect(result.status).toBe(0);
    expect(lstatSync(enabled).isSymbolicLink()).toBe(true);
    expect(readlinkSync(enabled)).toBe(linkBefore);
    expect(readFileSync(enabledTarget, "utf8")).toBe(enabledBytes);
    expect(readdirSync(f.config).some(name => name.startsWith("community-plugins.json.bak-"))).toBe(false);
  });

  it.each(["unknown", "not-an-array"])("does not create an enabled list for %s input", kind => {
    const f = fixture("new-id");
    const enabled = path.join(f.config, "community-plugins.json");
    const bytes = kind === "unknown" ? '{"enabled":true}\n' : "null\n";
    writeFileSync(enabled, bytes);
    expect(run(f, f.backup, ["--set-enabled"]).status).toBe(0);
    expect(readFileSync(enabled, "utf8")).toBe(bytes);
    expect(readdirSync(f.config).some(name => name.startsWith("community-plugins.json.bak-"))).toBe(false);
  });
});
