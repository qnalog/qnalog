import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || ""),
  TFile: class {}, TFolder: class {},
}));
import {
  describeEndpointIssue,
  inferEndpointTransport,
  getServiceEndpointSecurityIssue,
} from "../src/shared/util-llm-endpoint";

// 真机验证发现的误报：百炼录音转写是 wss:// 地址，检测却按 http 规则校验，
// 于是报「协议不受支持」——服务本身完全正常。这里钉住「按地址自身协议校验」。
describe("服务地址按自身协议校验", () => {
  it("由地址推断传输方式", () => {
    expect(inferEndpointTransport("wss://dashscope.aliyuncs.com/api-ws/v1/inference")).toBe("websocket");
    expect(inferEndpointTransport("ws://127.0.0.1:8080/x")).toBe("websocket");
    expect(inferEndpointTransport("https://api.example.com/v1")).toBe("http");
    expect(inferEndpointTransport("http://127.0.0.1:8000/v1")).toBe("http");
    expect(inferEndpointTransport("")).toBe("http");
  });

  it("wss:// 公网地址合法（旧实现按 http 校验会误报协议不受支持）", () => {
    const endpoint = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
    // 旧实现的错误结论
    expect(getServiceEndpointSecurityIssue(endpoint, "http", "转写服务地址")).toContain("协议不受支持");
    // 正确结论
    expect(describeEndpointIssue(endpoint, "转写服务地址")).toBe("");
  });

  it("https:// 转写地址仍然合法", () => {
    expect(describeEndpointIssue("https://api.siliconflow.cn/v1/audio/transcriptions")).toBe("");
  });

  it("公网明文 ws:// 仍被拒绝（安全规则没有被放宽）", () => {
    expect(describeEndpointIssue("ws://api.example.com/ws", "转写服务地址")).toContain("不安全");
    expect(describeEndpointIssue("http://api.example.com/v1", "转写服务地址")).toContain("不安全");
  });

  it("本机与私网的明文地址仍被允许", () => {
    expect(describeEndpointIssue("ws://127.0.0.1:9000/ws")).toBe("");
    expect(describeEndpointIssue("http://192.168.1.10:8000/v1")).toBe("");
  });
});
