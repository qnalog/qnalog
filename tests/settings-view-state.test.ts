import { describe, expect, it } from "vitest";
import { canOmitServiceApiKey } from "../src/shared/util-llm-endpoint";
import { buildServiceView, deriveSetupState } from "../src/setup";
import {
  isQuickSetupVisible,
  resolvePanelOpen,
  resolveScrollTop,
} from "../src/setup/settings-view-state";

const base = { openedByUser: false, dismissed: false };

describe("quick setup card visibility", () => {
  it("shows when transcription or AI organize is missing", () => {
    expect(isQuickSetupVisible({ ...base, transcribeState: "missing", llmState: "success" })).toBe(true);
    expect(isQuickSetupVisible({ ...base, transcribeState: "untested", llmState: "missing" })).toBe(true);
  });
  it("hides again once both services are configured (recomputed per render)", () => {
    expect(isQuickSetupVisible({ ...base, transcribeState: "missing", llmState: "missing" })).toBe(true);
    expect(isQuickSetupVisible({ ...base, transcribeState: "untested", llmState: "untested" })).toBe(false);
    expect(isQuickSetupVisible({ ...base, transcribeState: "failure", llmState: "success" })).toBe(false);
  });
  it("close button hides it even while config is missing", () => {
    expect(isQuickSetupVisible({ transcribeState: "missing", llmState: "missing", openedByUser: false, dismissed: true })).toBe(false);
  });
  it("explicit open shows it even when configured", () => {
    expect(isQuickSetupVisible({ transcribeState: "success", llmState: "success", openedByUser: true, dismissed: false })).toBe(true);
  });
});

describe("local endpoints without a key count as configured", () => {
  const hosts = [
    "http://10.1.2.3:18080/v1/audio/transcriptions",
    "http://172.16.0.5:18080/v1/audio/transcriptions",
    "http://172.31.255.1:8000/v1/audio/transcriptions",
    "http://192.168.1.20:18080/v1/audio/transcriptions",
    "http://localhost:18080/v1/audio/transcriptions",
    "http://127.0.0.1:18080/v1/audio/transcriptions",
    "http://100.64.0.1:18080/v1/audio/transcriptions",
    "http://100.101.102.103:18080/v1/audio/transcriptions",
    "http://100.127.255.254:18080/v1/chat/completions",
    "http://192.168.1.20:1234/v1",
  ];
  for (const endpoint of hosts) {
    it(`omits key: ${endpoint}`, () => {
      expect(canOmitServiceApiKey(endpoint)).toBe(true);
      const requiresKey = !canOmitServiceApiKey(endpoint);
      const state = deriveSetupState(buildServiceView({ endpoint, model: "m", apiKey: "" }, requiresKey));
      expect(state).toBe("untested");
    });
  }
  it("still requires a key for public and out-of-range hosts", () => {
    for (const endpoint of ["https://api.openai.com/v1", "http://100.63.0.1:80/v1", "http://100.128.0.1:80/v1", "http://172.32.0.1/v1"]) {
      expect(canOmitServiceApiKey(endpoint)).toBe(false);
      const state = deriveSetupState(buildServiceView({ endpoint, model: "m", apiKey: "" }, true));
      expect(state).toBe("missing");
    }
  });
});

describe("provider panel open state", () => {
  it("uses the default only the first time, then keeps the user's choice", () => {
    const store: Record<string, boolean> = {};
    expect(resolvePanelOpen(store, "api:0:custom", true)).toBe(true);
    store["api:0:custom"] = false;
    expect(resolvePanelOpen(store, "api:0:custom", true)).toBe(false);
    store["api:0:custom"] = true;
    expect(resolvePanelOpen(store, "api:0:custom", false)).toBe(true);
  });
});

describe("scroll position across re-renders", () => {
  it("keeps position within the same tab", () => {
    expect(resolveScrollTop("api", "api", 420)).toBe(420);
  });
  it("resets on tab switch and first open", () => {
    expect(resolveScrollTop("api", "home", 420)).toBe(0);
    expect(resolveScrollTop(null, "api", 420)).toBe(0);
  });
});
