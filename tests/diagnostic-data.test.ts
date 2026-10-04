import { describe, expect, it } from "vitest";

import { diagnosticError, redactDiagnosticText, sanitizeDiagnosticData } from "../src/shared/util-key-diag";

describe("diagnostic data sanitization", () => {
  it("redacts Error and structural thrown values while retaining safe status fields", () => {
    const error = Object.assign(new Error("Bearer fixture-secret-123"), {
      status: 503,
      statusDetail: "token=fixture-detail-secret",
      nonRetryable: false,
    });
    const result = diagnosticError(error);
    expect(result).toMatchObject({
      name: "Error",
      message: "Bearer <redacted>",
      status: 503,
      statusDetail: "token=<redacted>",
      nonRetryable: false,
    });
    expect(result.stack).toContain("Bearer <redacted>");
    expect(result.stack).not.toContain("fixture-secret-123");

    const thrown = {
      name: "ServiceError",
      message: "apiKey=fixture-structural-secret",
      stack: "ServiceError: apiKey=fixture-structural-secret\n at /Users/Fixture/local\n third\n fourth\n fifth",
      status: 401,
      statusDetail: "secret=fixture-status-secret",
      nonRetryable: true,
    };
    expect(diagnosticError(thrown)).toEqual({
      name: "ServiceError",
      message: "apiKey=<redacted>",
      stack: "ServiceError: apiKey=<redacted>\n at /Users/<user>/local\n third\n fourth",
      status: 401,
      statusDetail: "secret=<redacted>",
      nonRetryable: true,
    });
    expect(thrown.message).toBe("apiKey=fixture-structural-secret");
  });

  it("does not invent fields for primitive thrown values", () => {
    expect(diagnosticError("fixture thrown")).toEqual({ name: "Error", message: "fixture thrown", stack: "" });
    expect(diagnosticError(null)).toEqual({ name: "Error", message: "", stack: "" });
    expect(diagnosticError(false)).toEqual({ name: "Error", message: "", stack: "" });
  });

  it("redacts nested secrets and limits paths without mutating input", () => {
    const input = {
      apiKey: "fixture-api-secret",
      notePath: "/Users/Fixture/meeting.md",
      nested: { token: "fixture-nested-secret", detail: "safe" },
      number: 0,
      flag: false,
    };
    expect(sanitizeDiagnosticData(input)).toEqual({
      apiKey: "<redacted>",
      notePath: "meeting.md",
      nested: { token: "<redacted>", detail: "safe" },
      number: 0,
      flag: false,
    });
    expect(input).toEqual({
      apiKey: "fixture-api-secret",
      notePath: "/Users/Fixture/meeting.md",
      nested: { token: "fixture-nested-secret", detail: "safe" },
      number: 0,
      flag: false,
    });
  });

  it("enforces array, object, nesting, text, and stack boundaries", () => {
    expect(sanitizeDiagnosticData(Array.from({ length: 21 }, (_, index) => index))).toEqual(
      Array.from({ length: 20 }, (_, index) => index),
    );

    const keys = Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`field${index}`, index]));
    const sanitizedKeys = sanitizeDiagnosticData(keys) as Record<string, unknown>;
    expect(Object.keys(sanitizedKeys)).toHaveLength(40);
    expect(sanitizedKeys.field39).toBe(39);
    expect(sanitizedKeys.field40).toBeUndefined();

    expect(sanitizeDiagnosticData({ one: { two: { three: "at depth three" } } })).toEqual({
      one: { two: { three: "at depth three" } },
    });
    expect(sanitizeDiagnosticData({ one: { two: { three: { four: "at depth four" } } } })).toEqual({
      one: { two: { three: { four: "[depth-limit]" } } },
    });

    expect(redactDiagnosticText("x".repeat(1200))).toHaveLength(1200);
    expect(redactDiagnosticText("x".repeat(1201))).toHaveLength(1200);
    expect(diagnosticError({ stack: "line one\nline two\nline three\nline four\nline five" }).stack)
      .toBe("line one\nline two\nline three\nline four");
  });
});
