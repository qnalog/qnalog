import { t } from "../../shared/i18n";

export interface SedimentScanFile {
  path: string;
  basename: string;
}

export interface SedimentScanTaskAction {
  id: string;
  label: string;
  primary?: boolean;
}

export interface SedimentScanTaskPort {
  startTaskActivity(input: {
    id: string;
    kind: "sediment";
    title: string;
    subject: string;
    status: "running";
    stage: "reading";
    stageLabel: string;
    detail: string;
    progress: number;
    actions: [];
  }): void;
  patchTaskActivity(id: string, patch: {
    stage: "extracting" | "persisting";
    stageLabel: string;
    detail: string;
    progress: number;
    deadlineAt: number;
  }): void;
  cancelTaskActivity(id: string, reason: string): void;
  completeTaskActivity(id: string, result: {
    stage: "done";
    stageLabel: string;
    detail: string;
    progress: number;
    actions: SedimentScanTaskAction[];
  }): void;
  failTaskActivity(id: string, error: unknown, result: {
    stage: "failed";
    stageLabel: string;
    detail: string;
    subject: string;
    actions: SedimentScanTaskAction[];
  }): void;
}
type SedimentScanCancelTaskPort = Pick<SedimentScanTaskPort, "cancelTaskActivity">;

export interface SedimentScanNormalized {
  people: unknown[];
  todos: unknown[];
  hotwords: unknown;
}

export interface SedimentScanGroupState {
  groups: Array<{ key: string }>;
}

export interface SedimentScanFlowPort {
  currentToken(): number;
  incrementToken(): number;
  patchBucket(file: SedimentScanFile, patch: Record<string, unknown>): void;
  persistBucket(file: SedimentScanFile): Promise<boolean>;
  readMarkdown(file: SedimentScanFile): Promise<string>;
  generate(file: SedimentScanFile, markdown: string): Promise<unknown>;
  normalizeAndAddIds(objects: unknown, normalizedPath: string, basename: string): SedimentScanNormalized;
  normalizePath(path: string): string;
  createVocabularyGroups(): unknown;
  initialCounts(normalized: SedimentScanNormalized): unknown;
  countRawPeople(objects: unknown): number;
  countRawTodos(objects: unknown): number;
  countRawHotwords(objects: unknown): number;
  selectGroupState(file: SedimentScanFile): SedimentScanGroupState;
  findNextPendingGroup(groups: SedimentScanGroupState["groups"]): { key: string } | undefined;
  setSelectedGroup(group: string): void;
  setSwitcherOpen(open: boolean): void;
  render(): void;
  showToast(message: string, options: { icon: string; variant?: string }): void;
  showFailureNotice(error: unknown, duration: number): void;
  errorMessage(error: unknown): string;
  logFailure(error: unknown): void;
  tasks: SedimentScanTaskPort;
}
type SedimentScanCancelPort = Pick<SedimentScanFlowPort, "incrementToken" | "patchBucket" | "render" | "showToast"> & { tasks: SedimentScanCancelTaskPort };

function scanDetail(port: SedimentScanFlowPort, objects: unknown, separator: " · " | ", "): string {
  const todoSeparator = separator === " · " ? t(" · to-dos ") : t(", to-dos ");
  const hotwordSeparator = separator === " · " ? t(" · hotwords ") : t(", hot words ");
  return `${t("people ")}${port.countRawPeople(objects)}${todoSeparator}${port.countRawTodos(objects)}${hotwordSeparator}${port.countRawHotwords(objects)}`;
}

export async function scanSedimentFile(port: SedimentScanFlowPort, file: SedimentScanFile): Promise<void> {
  const token = port.incrementToken();
  const taskId = `sediment:${file.path}`;
  try {
    port.tasks.startTaskActivity({
      id: taskId,
      kind: "sediment",
      title: t("Scan minutes objects"),
      subject: file.path,
      status: "running",
      stage: "reading",
      stageLabel: t("Read the minutes content"),
      detail: file.basename,
      progress: 5,
      actions: [],
    });
    port.patchBucket(file, { scanning: true, scanStartedAt: new Date().toISOString() });
    port.render();
    const markdown = await port.readMarkdown(file);
    port.tasks.patchTaskActivity(taskId, {
      stage: "extracting",
      stageLabel: t("AI is identifying people, to-dos and hot words"),
      detail: t("This task's state is kept until the service returns"),
      progress: 25,
      deadlineAt: Date.now() + 180_000,
    });
    const objects = await port.generate(file, markdown);
    if (token !== port.currentToken()) {
      port.tasks.cancelTaskActivity(taskId, t("This scan was cancelled; the note content was not changed"));
      return;
    }
    const normalized = port.normalizeAndAddIds(objects, port.normalizePath(file.path || ""), file.basename);
    port.patchBucket(file, {
      people: normalized.people || [],
      todos: normalized.todos || [],
      hotwords: normalized.hotwords || port.createVocabularyGroups(),
      scannedAt: new Date().toISOString(),
      initialCounts: port.initialCounts(normalized),
      doneGroups: [],
      selectedByGroup: {},
      decisionLogByGroup: {},
      transitionGroup: "",
      scanning: false,
      scanStartedAt: "",
    });
    port.tasks.patchTaskActivity(taskId, {
      stage: "persisting",
      stageLabel: t("Saving candidates"),
      detail: scanDetail(port, objects, " · "),
      progress: 85,
      deadlineAt: 0,
    });
    const persisted = await port.persistBucket(file);
    if (!persisted) throw new Error(t("Candidates were generated, but writing back to the note failed"));
    const nextState = port.selectGroupState(file);
    const firstPending = port.findNextPendingGroup(nextState.groups);
    port.setSelectedGroup(firstPending ? firstPending.key : "person");
    port.setSwitcherOpen(false);
    port.render();
    port.showToast(`${t("Scan complete: people ")}${port.countRawPeople(objects)}${t(", to-dos ")}${port.countRawTodos(objects)}${t(", hot words ")}${port.countRawHotwords(objects)}`, { icon: "check" });
    port.tasks.completeTaskActivity(taskId, {
      stage: "done",
      stageLabel: t("Target scan complete"),
      detail: scanDetail(port, objects, " · "),
      progress: 100,
      actions: [
        { id: "open-task-note", label: t("Open minutes"), primary: true },
        { id: "dismiss-task", label: t("Dismiss") },
      ],
    });
  } catch (error) {
    if (token !== port.currentToken()) {
      port.tasks.cancelTaskActivity(taskId, t("This scan was cancelled; the note content was not changed"));
      return;
    }
    port.patchBucket(file, { scanning: false, scanStartedAt: "" });
    port.render();
    port.logFailure(error);
    port.tasks.failTaskActivity(taskId, error, {
      stage: "failed",
      stageLabel: t("Target scan incomplete"),
      detail: port.errorMessage(error),
      subject: file.path,
      actions: [
        { id: "open-task-note", label: t("Open minutes"), primary: true },
        { id: "dismiss-task", label: t("Dismiss") },
      ],
    });
    port.showFailureNotice(error, 8000);
  }
}

export function cancelSedimentScan(port: SedimentScanCancelPort, file: SedimentScanFile): void {
  port.incrementToken();
  port.patchBucket(file, { scanning: false, scanStartedAt: "" });
  port.tasks.cancelTaskActivity(`sediment:${file.path}`, t("This scan was cancelled; the note content was not changed"));
  port.render();
  port.showToast(t("This scan was cancelled"), { icon: "circle-minus", variant: "muted" });
}
