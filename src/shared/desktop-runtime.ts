type RuntimeRequire = (id: string) => unknown;

export interface DesktopProcess {
  platform?: string;
  getProcessMemoryInfo?: () => Promise<{
    private?: number;
    residentSet?: number;
  }>;
}

export function getDesktopModule<T = unknown>(id: string): T | undefined {
  const focusedWindow = activeWindow as Window & { require?: RuntimeRequire };
  const mainWindow = window as Window & { require?: RuntimeRequire };
  const runtimeRequire = focusedWindow.require ?? mainWindow.require;
  if (typeof runtimeRequire !== "function") return undefined;
  try {
    return runtimeRequire(id) as T;
  } catch {
    return undefined;
  }
}

export function getDesktopProcess(): DesktopProcess | undefined {
  const runtimeWindow = activeWindow as Window & { process?: unknown };
  const value = runtimeWindow.process;
  return value !== null && typeof value === "object" ? value : undefined;
}
