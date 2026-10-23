import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ Notice: class {}, TFile: class {}, normalizePath: (p: string) => p }));
vi.mock("../src/ui/modals", () => ({ BubbleWidget: class {} }));
import { ViewShellService, type ViewShellHost } from "../src/ui/view-shell-service";

// Obsidian 1.14 opens settings in its own window. The floating button used to be created in whichever
// window was active, so turning it back on from settings put it in the settings window, and it vanished
// when that window closed; the widget still held the detached element and never mounted again.
function fakeBubble(connected: boolean) {
  const bubble = {
    wrapEl: { isConnected: connected } as { isConnected: boolean } | null,
    mount: vi.fn(() => { bubble.wrapEl = { isConnected: true }; }),
    unmount: vi.fn(() => { bubble.wrapEl = null; }),
    show: vi.fn(),
    keepInViewport: vi.fn(),
    updateDockTail: vi.fn(),
  };
  return bubble;
}

function shellWith(bubble: ReturnType<typeof fakeBubble>, showFloatingBall: boolean) {
  return new ViewShellService({ bubble, ribbonEl: null, settings: { showFloatingBall } } as unknown as ViewShellHost);
}

describe("floating button visibility", () => {
  it("remounts the button when its element was left in a closed window", () => {
    const bubble = fakeBubble(false);
    shellWith(bubble, true).syncBubbleVisibility();
    expect(bubble.unmount).toHaveBeenCalledTimes(1);
    expect(bubble.mount).toHaveBeenCalledTimes(1);
    expect(bubble.wrapEl?.isConnected).toBe(true);
  });

  it("keeps a connected button and only refreshes it", () => {
    const bubble = fakeBubble(true);
    shellWith(bubble, true).syncBubbleVisibility();
    expect(bubble.unmount).not.toHaveBeenCalled();
    expect(bubble.mount).not.toHaveBeenCalled();
    expect(bubble.show).toHaveBeenCalledTimes(1);
  });

  it("stays unmounted when the switch is off", () => {
    const bubble = fakeBubble(false);
    shellWith(bubble, false).syncBubbleVisibility();
    expect(bubble.mount).not.toHaveBeenCalled();
    expect(bubble.wrapEl).toBeNull();
  });
});
