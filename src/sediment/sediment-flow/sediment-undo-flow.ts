export interface SedimentUndoFlowPort<TUndo> {
  restoreEntries(undo: TUndo): Promise<void>;
  restoreVocabulary(undo: TUndo): Promise<void>;
  restoreSourceSnapshot(undo: TUndo): Promise<void>;
  restoreBucket(undo: TUndo): Promise<void>;
  render(): void;
  showUndoToast(): void;
  presentError(error: unknown): void;
}

/** Undo records are passed by the caller so each invocation restores its own one-slot record. */
export async function restoreSedimentCommitFlow<TUndo>(
  port: SedimentUndoFlowPort<TUndo>,
  undo: TUndo | null | undefined,
): Promise<void> {
  if (!undo) return;
  try {
    await port.restoreEntries(undo);
    await port.restoreVocabulary(undo);
    await port.restoreSourceSnapshot(undo);
    await port.restoreBucket(undo);
    port.render();
    port.showUndoToast();
  } catch (error: unknown) {
    port.presentError(error);
  }
}
