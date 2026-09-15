import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || ""),
  TFile: class {}, TFolder: class {}, Notice: class {},
  requestUrl: async () => ({ status: 200, text: "{}" }),
}));

import { describeSegmentRetryUnavailable } from "../src/queue/queue-retry-service";

// 真机验证发现的残留问题：切到百炼实时转写（wss://）之前录下的音频，其分段任务还在队列里；
// 点「重试」时逐段走 HTTP 上传，于是每次都撞「协议不受支持」。
// 分段任务只对 HTTP 上传型服务有意义，流式服务必须直接说清不能逐段重试。
describe("分段重试的服务能力判定", () => {
  const hostWith = (profile: unknown) => ({ profiles: { getActiveTranscribeProfile: () => profile } });

  it("流式服务不能逐段重试，给出原因", () => {
    const reason = describeSegmentRetryUnavailable(hostWith({ transcribeMode: "streaming", title: "阿里云百炼实时转写" }));
    expect(reason).toContain("流式服务");
    expect(reason).toContain("不能逐段重试");
  });

  it("分段上传型服务可以逐段重试", () => {
    expect(describeSegmentRetryUnavailable(hostWith({ transcribeMode: "segmented" }))).toBe("");
  });

  it("整文件型服务不在此判定范围（它走的是另一条路径）", () => {
    expect(describeSegmentRetryUnavailable(hostWith({ transcribeMode: "whole-file" }))).toBe("");
  });

  it("拿不到 profile 时不拦（避免因探测失败而让重试彻底不可用）", () => {
    expect(describeSegmentRetryUnavailable({})).toBe("");
    expect(describeSegmentRetryUnavailable(null)).toBe("");
  });
});
