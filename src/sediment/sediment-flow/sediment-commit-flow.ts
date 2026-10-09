export interface SedimentCommitFlowPort<TUndo> {
  snapshotBucket(): TUndo | Promise<TUndo>;
  /** Runs the group-specific writer and vocabulary/settings mutations. */
  write?(undo: TUndo): Promise<void>;
  recordDecisionLog(): void | Promise<void>;
  markDone(): boolean;
  persistBucket(): Promise<boolean>;
  render(): void;
  showCommitToast(undo: TUndo): void;
  scheduleAutoAdvance(): void;
  /** The people workflow historically shows its result toast even when note persistence fails. */
  showToastWhenPersistenceFails?: boolean;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return "then" in value && typeof value.then === "function";
}

/** Commit order shared by to-do, hotword, and people decisions. */
export async function commitSedimentGroupFlow<TUndo>(port: SedimentCommitFlowPort<TUndo>): Promise<void> {
  const snapshot = port.snapshotBucket();
  const undo = isPromiseLike(snapshot) ? await snapshot : snapshot;
  if (port.write) await port.write(undo);
  const decisionLog = port.recordDecisionLog();
  if (isPromiseLike(decisionLog)) await decisionLog;
  const completed = port.markDone();
  const persisted = await port.persistBucket();
  port.render();
  if (persisted || port.showToastWhenPersistenceFails) port.showCommitToast(undo);
  if (completed) port.scheduleAutoAdvance();
}
