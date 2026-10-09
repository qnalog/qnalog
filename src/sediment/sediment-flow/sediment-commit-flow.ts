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

/** Commit order shared by to-do, hotword, and people decisions. */
export async function commitSedimentGroupFlow<TUndo>(port: SedimentCommitFlowPort<TUndo>): Promise<void> {
  const undo = await port.snapshotBucket();
  if (port.write) await port.write(undo);
  await port.recordDecisionLog();
  const completed = port.markDone();
  const persisted = await port.persistBucket();
  port.render();
  if (persisted || port.showToastWhenPersistenceFails) port.showCommitToast(undo);
  if (completed) port.scheduleAutoAdvance();
}
