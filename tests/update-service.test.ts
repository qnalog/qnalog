import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import type { AvailableUpdate } from "../src/shared/types";
import {
  UpdateService,
  type UpdateAdapter,
  type UpdateRuntime,
  type UpdateSettings,
} from "../src/update-service";
import {
  pluginBasePath,
  resolveUpdateRawBases,
} from "../src/update-source";

const NOW = Date.parse("2025-02-03T04:05:06.789Z");
const BASE_PATH = ".obsidian/plugins/qnalog";

type RequestHandler = (url: string) => Promise<{ status: number; text: string }>;

class MemoryAdapter implements UpdateAdapter {
  readonly files = new Map<string, string>();
  readonly events: string[];

  constructor(events: string[], initialFiles: Record<string, string> = {}) {
    this.events = events;
    for (const [path, content] of Object.entries(initialFiles)) this.files.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    this.events.push(`exists:${path}`);
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    this.events.push(`read:${path}`);
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`missing ${path}`);
    return content;
  }

  async write(path: string, data: string): Promise<void> {
    this.events.push(`write:${path}`);
    this.files.set(path, data);
  }

  async mkdir(path: string): Promise<void> {
    this.events.push(`mkdir:${path}`);
    this.files.set(path, "<dir>");
  }
}

interface FixtureOptions {
  currentVersion?: string;
  buildVersion?: string;
  availableUpdate?: AvailableUpdate | null;
  initialFiles?: Record<string, string>;
  request?: RequestHandler;
  now?: number;
}

function fileNameFromUrl(url: string): string {
  return new URL(url).pathname.split("/").pop() ?? "";
}

function createFixture(options: FixtureOptions = {}) {
  const events: string[] = [];
  const notices: Array<{ message: string; duration?: number }> = [];
  const warnings: Array<{ message: string; error?: unknown }> = [];
  const now = options.now ?? NOW;
  const settings: UpdateSettings = {
    lastUpdateCheckAt: null,
    availableUpdate: options.availableUpdate ?? null,
    lastUpdateError: "",
  };
  const adapter = new MemoryAdapter(events, options.initialFiles);
  const request = options.request ?? (async (url: string) => {
    const fileName = fileNameFromUrl(url);
    if (fileName === "manifest.json") {
      return { status: 200, text: JSON.stringify({ id: "qnalog", version: "2.0.0" }) };
    }
    return { status: 200, text: `remote:${fileName}` };
  });
  const saveSettings = vi.fn(async () => { events.push("saveSettings"); });
  const runtime: UpdateRuntime = {
    requestUrl: async ({ url }) => {
      events.push(`request:${url}`);
      return request(url);
    },
    notice: (message, duration) => notices.push({ message, duration }),
    warn: (message, error) => warnings.push({ message, error }),
    now: () => now,
    normalizePath: (path) => path.replace(/\\/g, "/").replace(/\/+/g, "/"),
    buildVersion: options.buildVersion ?? options.currentVersion ?? "1.0.0",
  };
  const service = new UpdateService({
    settings,
    manifest: { id: "qnalog", version: options.currentVersion ?? "1.0.0" },
    configDir: ".obsidian",
    adapter,
    saveSettings,
  }, runtime);
  return {
    service,
    settings,
    adapter,
    events,
    notices,
    warnings,
    saveSettings,
  };
}

describe("update source and path resolution", () => {
  it("keeps the project branch and versioned source ordering", () => {
    expect(resolveUpdateRawBases()).toEqual([
      "https://raw.githubusercontent.com/qnalog/qnalog/main",
      "https://fastly.jsdelivr.net/gh/qnalog/qnalog@main",
      "https://cdn.jsdelivr.net/gh/qnalog/qnalog@main",
    ]);
    expect(pluginBasePath({
      app: { vault: { configDir: ".obsidian" } },
      manifest: { id: "qnalog", dir: ".obsidian/plugins/qnalog" },
    })).toBe(BASE_PATH);
  });
});


describe("UpdateService checks", () => {
  it("falls back in source order, writes check state, and still notices a new version when silent", async () => {
    const requestedHosts: string[] = [];
    const fixture = createFixture({
      request: async (url) => {
        requestedHosts.push(new URL(url).host);
        if (url.startsWith("https://raw.githubusercontent.com/")) throw new Error("primary down");
        return { status: 200, text: JSON.stringify({ id: "qnalog", version: "2.0.0" }) };
      },
    });

    const info = await fixture.service.checkForUpdates({ silent: true });
    expect(requestedHosts.slice(0, 2)).toEqual(["raw.githubusercontent.com", "fastly.jsdelivr.net"]);
    expect(info?.rawBaseUrl).toBe("https://fastly.jsdelivr.net/gh/qnalog/qnalog@main");
    expect(fixture.settings.availableUpdate).toEqual(info);
    expect(fixture.settings.lastUpdateCheckAt).toBe(new Date(NOW).toISOString());
    expect(fixture.settings.lastUpdateError).toBe("");
    expect(fixture.saveSettings).toHaveBeenCalledTimes(1);
    expect(fixture.notices).toHaveLength(1);
    expect(fixture.notices[0]?.duration).toBe(12000);
    expect(fixture.notices[0]?.message).toContain("2.0.0");
    expect(fixture.notices[0]?.message).toContain("1.0.0");
  });

  it("saves failed check status while respecting silent Notice semantics", async () => {
    const fixture = createFixture({ request: async () => { throw new Error("offline"); } });
    const result = await fixture.service.checkForUpdates({ silent: true });
    expect(result).toBeNull();
    expect(fixture.settings.lastUpdateCheckAt).toBe(new Date(NOW).toISOString());
    expect(fixture.settings.lastUpdateError).toContain("raw.githubusercontent.com");
    expect(fixture.saveSettings).toHaveBeenCalledTimes(1);
    expect(fixture.notices).toEqual([]);
    expect(fixture.warnings[0]?.message).toBe("[QnALog] update check failed");
  });
});

describe("UpdateService skew warning", () => {
  it("preserves the build/manifest mismatch warning", () => {
    const fixture = createFixture({ currentVersion: "2.0.0", buildVersion: "1.9.0" });
    fixture.service.warnIfBuildManifestSkew();
    expect(fixture.warnings[0]?.message).toBe(
      "[QnALog] build/manifest 版本错位：main.js=1.9.0 manifest=2.0.0",
    );
    expect(fixture.notices).toHaveLength(1);
    expect(fixture.notices[0]?.duration).toBe(0);
    expect(fixture.notices[0]?.message).toContain("1.9.0");
    expect(fixture.notices[0]?.message).toContain("2.0.0");
  });
});
