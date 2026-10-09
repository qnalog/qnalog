export interface SedimentAdvanceGroup {
  key: string;
  total: number;
  done: number;
}

export interface SedimentAdvanceFile {
  path: string;
}

export interface SedimentAdvanceFlowPort<TFile extends SedimentAdvanceFile, TTimer> {
  isFile(file: TFile): boolean;
  normalizePath(path: string): string;
  getTimer(): TTimer | 0;
  setTimer(timer: TTimer | 0): void;
  clearTimer(timer: TTimer): void;
  scheduleTimer(callback: () => void, delayMs: number): TTimer;
  getActiveNotePath(): string;
  getGroups(file: TFile): readonly SedimentAdvanceGroup[];
  findNextPendingGroup(groups: readonly SedimentAdvanceGroup[], completedKey: string): SedimentAdvanceGroup | null;
  clearTransitionGroup(file: TFile): void;
  selectGroup(key: string): void;
  render(): void;
}

/** Schedule the single delayed transition used after a sediment group is completed. */
export function scheduleSedimentAutoAdvance<TFile extends SedimentAdvanceFile, TTimer>(
  port: SedimentAdvanceFlowPort<TFile, TTimer>,
  file: TFile,
  completedKey: string,
): void {
  if (!port.isFile(file)) return;
  const previous = port.getTimer();
  if (previous) port.clearTimer(previous);
  const path = port.normalizePath(file.path || "");
  const timer = port.scheduleTimer(() => {
    port.setTimer(0);
    const activePath = port.getActiveNotePath();
    const normalizedActivePath = activePath ? port.normalizePath(activePath) : "";
    if (normalizedActivePath && path && normalizedActivePath !== path) return;
    const next = port.findNextPendingGroup(port.getGroups(file), completedKey);
    port.clearTransitionGroup(file);
    if (next) port.selectGroup(next.key);
    else port.render();
  }, 1000);
  port.setTimer(timer);
}
