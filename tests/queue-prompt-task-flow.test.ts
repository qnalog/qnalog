import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ notices: [] as Array<{ message: string; duration: number }> }));
vi.mock("obsidian", () => ({
  TFile: class TFile {}, TFolder: class TFolder {},
  Notice: class Notice { constructor(message: string, duration: number) { state.notices.push({ message: String(message), duration }); } },
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  requestUrl: vi.fn(async () => ({ status: 200, text: "{}" })),
}));
import { QueueRetryService } from "../src/queue/queue-retry-service";
afterEach(() => { vi.clearAllMocks(); state.notices.length = 0; });
function setup() {
  const events: string[] = [];
  const display = vi.fn(() => { events.push("display"); });
  const generateAndApplyIndustryPrompt = vi.fn(async (_mode: string, _options: { activate: boolean }) => { events.push("generate"); return { name: "Probe" }; });
  const host = { vocabulary: { generateAndApplyIndustryPrompt }, settingTab: { display } };
  return { service: new QueueRetryService(host as never), host, display, generateAndApplyIndustryPrompt, events };
}
describe("prompt task consumer contract", () => {
  it("rejects a missing mode before generating a prompt", async () => {
    const fixture = setup();
    await expect(fixture.service.runGeneratePromptTask({ mode: "" } as never)).rejects.toThrow("Missing mode");
    expect(fixture.generateAndApplyIndustryPrompt).not.toHaveBeenCalled();
  });
  it.each([undefined, true, false])("preserves activation, notice, and display behavior for activate=%s", async (activate) => {
    const fixture = setup();
    await fixture.service.runGeneratePromptTask({ mode: "meeting", activate } as never);
    expect(fixture.generateAndApplyIndustryPrompt).toHaveBeenCalledWith("meeting", { activate: activate !== false });
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0].duration).toBe(7000);
    expect(state.notices[0].message).toContain(activate === false ? "Created custom prompt" : "set as the current default");
    expect(fixture.display).toHaveBeenCalledTimes(1);
    expect(fixture.events).toEqual(["generate", "display"]);
  });
  it("does not notify or display after generation fails and reads the setting tab after the notice", async () => {
    const fixture = setup();
    const error = new Error("generation failed");
    fixture.generateAndApplyIndustryPrompt.mockRejectedValueOnce(error);
    await expect(fixture.service.runGeneratePromptTask({ mode: "meeting" } as never)).rejects.toBe(error);
    expect(state.notices).toHaveLength(0);
    expect(fixture.display).not.toHaveBeenCalled();
    const ordered = setup();
    let read = 0;
    Object.defineProperty(ordered.host, "settingTab", { configurable: true, get: () => { read++; return null; } });
    await ordered.service.runGeneratePromptTask({ mode: "meeting" } as never);
    expect(read).toBe(1);
    expect(state.notices).toHaveLength(1);
  });
});
