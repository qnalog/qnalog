import type { RecordingSession } from "../shared/types";
import { getErrorMessage } from "../shared/util-common";

export interface SessionFinalizeFlowHost {
  runFinalizer(session: RecordingSession): Promise<void>;
  reportFailure(session: RecordingSession, error: unknown): Promise<void>;
  settleContinuation(session: RecordingSession): Promise<void> | undefined;
  releaseSession(sessionId: string): void;
}

export async function finalizeSessionFlow(
  host: SessionFinalizeFlowHost,
  session: RecordingSession | null | undefined,
): Promise<void> {
  if (!session || session.finalized) return;
  if (session.finalizePromise !== null && session.finalizePromise !== undefined) return session.finalizePromise;

  const finalizePromise = (async () => {
    try {
      await host.runFinalizer(session);
      session.finalized = true;
      session.finalizationError = "";
    } catch (error) {
      session.finalizing = false;
      session.finalizationError = getErrorMessage(error);
      await host.reportFailure(session, error);
    }
  })();
  session.finalizePromise = finalizePromise;
  try {
    await finalizePromise;
  } finally {
    const continuationSettlement = host.settleContinuation(session);
    if (continuationSettlement !== undefined) await continuationSettlement;
    host.releaseSession(session.id);
    if (session.finalizePromise === finalizePromise) session.finalizePromise = null;
  }
}
