import { describe, expect, it } from "vitest";
import {
  appendActivityEvent,
  audioImportStageFromWorkProgress,
  buildAudioImportStages,
  classifyActivityRequest,
  getDominantActivityLiveness,
  getActivityStagePosition,
  normalizeAudioImportStage,
  summarizeActivityRequests,
  upsertActivityRequest,
} from "../src/shared/activity-progress";

describe("audio import activity progress", () => {
  it("maps import and finalization phases to the five user-facing stages", () => {
    expect(normalizeAudioImportStage("preparing")).toBe("prepare");
    expect(normalizeAudioImportStage("transcribing")).toBe("transcribe");
    expect(normalizeAudioImportStage("persisting")).toBe("persist");
    expect(audioImportStageFromWorkProgress("llm-merge")).toBe("organize");
    expect(audioImportStageFromWorkProgress("write-note")).toBe("write");
  });

  it("marks earlier stages complete and later stages pending", () => {
    const stages = buildAudioImportStages("transcribing");
    expect(stages.map((stage) => stage.status)).toEqual([
      "done",
      "active",
      "pending",
      "pending",
      "pending",
    ]);
    expect(getActivityStagePosition(stages)).toEqual({
      current: 2,
      total: 5,
      completed: 1,
    });
  });

  it("can represent a fully completed workflow", () => {
    const stages = buildAudioImportStages("write", true);
    expect(stages.every((stage) => stage.status === "done")).toBe(true);
    expect(getActivityStagePosition(stages)).toEqual({
      current: 5,
      total: 5,
      completed: 5,
    });
  });

  it("distinguishes live requests from slow and expired requests", () => {
    const now = 1_000_000;
    const request = {
      key: "0:0",
      chunkIndex: 0,
      chunkCount: 1,
      status: "requesting" as const,
      attempt: 1,
      maxAttempts: 3,
      startedAt: now - 1_000,
      updatedAt: now - 1_000,
      deadlineAt: now + 119_000,
      retryAt: 0,
      receivedChars: 0,
      error: "",
    };

    expect(classifyActivityRequest(request, now)).toBe("running");
    expect(classifyActivityRequest({
      ...request,
      startedAt: now - 5_000,
      updatedAt: now - 5_000,
    }, now)).toBe("waiting");
    expect(classifyActivityRequest({
      ...request,
      startedAt: now - 80_000,
      updatedAt: now - 35_000,
    }, now)).toBe("slow");
    expect(classifyActivityRequest({
      ...request,
      deadlineAt: now - 1,
    }, now)).toBe("stalled");
  });

  it("reports retry, failure and completion as explicit states", () => {
    const now = 2_000_000;
    const base = {
      key: "0:0",
      chunkIndex: 0,
      chunkCount: 1,
      attempt: 1,
      maxAttempts: 3,
      startedAt: now - 10_000,
      updatedAt: now,
      deadlineAt: 0,
      retryAt: 0,
      receivedChars: 0,
      error: "",
    };

    expect(classifyActivityRequest({ ...base, status: "retry-wait", retryAt: now + 5_000 }, now)).toBe("retrying");
    expect(classifyActivityRequest({ ...base, status: "failed" }, now)).toBe("failed");
    expect(classifyActivityRequest({ ...base, status: "done" }, now)).toBe("done");
  });

  it("resets request timing for a new attempt and keeps bounded event history", () => {
    const first = upsertActivityRequest([], {
      key: "0:0",
      chunkIndex: 0,
      chunkCount: 2,
      status: "requesting",
      attempt: 1,
      maxAttempts: 3,
      startedAt: 1_000,
      updatedAt: 1_000,
    });
    const second = upsertActivityRequest(first, {
      key: "0:0",
      status: "requesting",
      attempt: 2,
      updatedAt: 5_000,
    });
    expect(second[0].startedAt).toBe(5_000);
    expect(second[0].attempt).toBe(2);

    let events = [];
    for (let i = 0; i < 5; i++) {
      events = appendActivityEvent(events, {
        id: String(i),
        at: i + 1,
        stageId: "transcribe",
        type: "test",
        label: `event-${i}`,
      }, 3);
    }
    expect(events.map((event) => event.label)).toEqual(["event-2", "event-3", "event-4"]);
  });

  it("updates repeated polling events instead of filling the timeline with duplicates", () => {
    const first = appendActivityEvent([], {
      at: 1_000,
      stageId: "transcribe",
      type: "waiting",
      label: "正在发送给云端识别整段音频",
      detail: "音频时长 3:00:00 · 预计约 5–15 分钟完成",
    });
    const second = appendActivityEvent(first, {
      at: 4_000,
      stageId: "transcribe",
      type: "waiting",
      label: "正在发送给云端识别整段音频",
      detail: "音频时长 3:00:00 · 预计约 5–15 分钟完成",
    });

    expect(second).toHaveLength(1);
    expect(second[0].at).toBe(4_000);
  });

  it("summarizes concurrent chunks and surfaces the most urgent state", () => {
    const now = 3_000_000;
    const requests = [
      {
        key: "0:0",
        status: "streaming",
        startedAt: now - 1_000,
        updatedAt: now,
        deadlineAt: now + 30_000,
      },
      {
        key: "0:1",
        status: "requesting",
        startedAt: now - 60_000,
        updatedAt: now - 31_000,
        deadlineAt: now + 60_000,
      },
      {
        key: "0:2",
        status: "requesting",
        startedAt: now - 130_000,
        updatedAt: now - 130_000,
        deadlineAt: now - 10_000,
      },
    ];
    const summary = summarizeActivityRequests(requests, now);
    expect(summary.running).toBe(1);
    expect(summary.slow).toBe(1);
    expect(summary.stalled).toBe(1);
    expect(getDominantActivityLiveness(summary)).toBe("stalled");
  });
});
