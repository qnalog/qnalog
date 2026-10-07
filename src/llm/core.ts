/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。
import * as obsidian from "obsidian";
import { normalizeLlmEndpoint, isPoeLlmEndpoint, isMoonshotKimiModel, buildLlmHeaders, assertSafeServiceEndpoint, canOmitServiceApiKey, getServiceEndpointSecurityIssue } from '../shared/util-llm-endpoint';
import { applyThinkingParam } from './thinking';
import { delayMs } from '../shared/util-audio';
import { extractLlmContent } from '../shared/util-json';
import { diagnosticError } from '../shared/util-key-diag';
import { withPromiseTimeout, getHeaderValue, parseRetryAfterMs, parseRequestUrlJson, getRequestUrlText } from '../shared/util-http';
import { LlmRequestQueue } from './request-queue';
import { t } from '../shared/i18n';
import {
  applyLearnedLlmCapability,
  getEffectiveLlmOutputBudget,
  getLlmOutputBudgetFromOptions,
  rememberLlmOutputCeiling,
  rememberLlmOutputParameter,
} from './output-budget';
import {
  isLlmConfigError,
  isLlmContextLimitError,
  isLlmNonRetryableError,
  isLlmServiceBlockedError,
  isNonRetryableLlmHttpFailure,
} from "./failure-policy";
export { LlmRequestQueue } from './request-queue';

type LlmHttpError = Error & {
  status?: number;
  statusDetail?: string;
  retryAfterMs?: number;
  nonRetryable?: boolean;
};

export const LLM_REQUEST_QUEUE = new LlmRequestQueue();
const LLM_REQUESTURL_PREFERRED_ENDPOINTS = new Set<string>();

export function resetLearnedLlmTransportPreferences() {
  LLM_REQUESTURL_PREFERRED_ENDPOINTS.clear();
}

export function prefersObsidianRequestUrl(endpoint) {
  return LLM_REQUESTURL_PREFERRED_ENDPOINTS.has(normalizeLlmEndpoint(endpoint));
}

function rememberObsidianRequestUrlPreference(endpoint) {
  const normalized = normalizeLlmEndpoint(endpoint);
  if (normalized) LLM_REQUESTURL_PREFERRED_ENDPOINTS.add(normalized);
}

export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 180 * 1000;

export function resolveLlmRequestTimeoutMs(options) {
  const hasTimeout = options && Object.prototype.hasOwnProperty.call(options, "timeoutMs");
  const value = hasTimeout ? Number(options.timeoutMs) : NaN;
  if (Number.isFinite(value) && value > 0) return Math.max(1000, Math.round(value));
  if (hasTimeout && value === 0 && options && options.allowNoTimeout === true) return 0;
  return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
}

export function getLlmRetryAfterMsFromHeaders(headers) {
  const retryAfter = parseRetryAfterMs(getHeaderValue(headers, "retry-after"));
  if (retryAfter > 0) return retryAfter;
  return parseRetryAfterMs(getHeaderValue(headers, "x-ratelimit-reset-requests"));
}

export function decorateLlmHttpDetail(status, detail, endpoint) {
  const base = String(detail || "").trim();
  if (!isPoeLlmEndpoint(endpoint)) return base;
  const code = Number(status) || 0;
  let hint = "";
  if (code === 400 || code === 404) {
    hint = t("For Poe, the model must be a Poe bot name and is case-sensitive; click \"Get available models\" and pick from the list.");
  } else if (code === 401 || code === 403) {
    hint = t("Check that your Poe API Key is valid and is used as a Bearer token.");
  } else if (code === 402) {
    hint = t("Not enough Poe credits or subscription quota; check your quota in your Poe account.");
  } else if (code === 413) {
    hint = t("This request's context may exceed the target Poe bot's limit; shorten the input or switch to a bot with a longer context.");
  } else if (code === 429 || code === 503 || code === 529) {
    hint = t("Poe is rate-limiting or busy right now; QnALog will back off per the server's Retry-After and retry once.");
  }
  if (!hint) return base;
  return base ? t("{0}. {1}").replace("{0}", base).replace("{1}", hint) : hint;
}

export function isTokenPlanLlmEndpoint(endpoint) {
  return /token-plan/i.test(String(endpoint || ""));
}

export function shouldRetryTokenPlanParamError(status, detail, endpoint) {
  return Number(status) === 400
    && isTokenPlanLlmEndpoint(endpoint)
    && /param\s*incorrect|invalid\s*param|invalid\s*parameter|unsupported/i.test(String(detail || ""));
}

export function makeTokenPlanCompatPayload(payload) {
  const next = Object.assign({}, payload || {});
  delete next.temperature;
  delete next.enable_thinking;
  delete next.thinking;
  delete next.reasoning_effort;
  next.stream = false;
  return next;
}

export async function readLlmError(res) {
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text);
    const detail = json && (json.error && json.error.message || json.message || json.detail);
    if (detail) return String(detail).slice(0, 500);
  } catch { /* intentionally empty */ }
  return text.slice(0, 500);
}

export function createLlmHttpError(status, detail, endpoint, headers) {
  const cleanDetail = decorateLlmHttpDetail(status, detail, endpoint).slice(0, 500);
  const err = new Error(t("LLM request failed with status {0}: {1}").replace("{0}", String(status)).replace("{1}", cleanDetail)) as LlmHttpError;
  err.status = status;
  err.statusDetail = cleanDetail;
  err.retryAfterMs = getLlmRetryAfterMsFromHeaders(headers);
  err.nonRetryable = isNonRetryableLlmHttpFailure(status, cleanDetail);
  return err;
}

export function pickLlmRequestError(fetchError, fallbackError) {
  const fallbackMessage = String((fallbackError && fallbackError.message) || fallbackError || "");
  const fetchMessage = String((fetchError && fetchError.message) || fetchError || "");
  if (fallbackError && (fallbackError.status || /LLM 调用失败\s+\d+|LLM request failed with status\s+\d+/.test(fallbackMessage))) return fallbackError;
  if (/Obsidian requestUrl 不可用|Obsidian requestUrl is unavailable/.test(fallbackMessage)) return fetchError;
  if (/Failed to fetch/i.test(fetchMessage) && fallbackMessage) return fallbackError;
  return fetchError || fallbackError;
}

export function countLlmMessageChars(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum, msg) => {
    const content = msg && msg.content;
    if (typeof content === "string") return sum + content.length;
    if (Array.isArray(content)) {
      return sum + content.reduce((n, part) => {
        if (typeof part === "string") return n + part.length;
        if (!part || typeof part !== "object") return n;
        return n + String(part.text || part.content || "").length;
      }, 0);
    }
    return sum;
  }, 0);
}

export async function logLlmRequestDiagnostic(plugin, level, code, message, data) {
  try {
    const diagnostics = plugin && plugin.diagnostics;
    if (diagnostics && typeof diagnostics.logDiagnostic === "function") {
      await diagnostics.logDiagnostic(level, code, message, data);
    }
  } catch (e) {
    console.warn("[QnALog] llm diagnostic failed", e);
  }
}

export async function requestLlmChatCompletionViaObsidian(endpoint, headers, payloadText, timeoutMs) {
  assertSafeServiceEndpoint(endpoint, "http", t("LLM service address"));
  if (!obsidian || typeof obsidian.requestUrl !== "function") {
    throw new Error(t("Obsidian requestUrl is unavailable"));
  }
  const request = obsidian.requestUrl({
    url: endpoint,
    method: "POST",
    headers,
    body: payloadText,
    throw: false,
  });
  const response = await withPromiseTimeout(request, timeoutMs, () => {
    const error = new Error(t("LLM fallback call timed out: no response within {0} seconds").replace("{0}", String(Math.round(timeoutMs / 1000)))) as LlmHttpError;
    // requestUrl cannot abort the underlying request. Retrying automatically could
    // submit the same paid generation twice while the first request is still running.
    error.nonRetryable = true;
    return error;
  });
  const status = Number(response && response.status) || 0;
  if (status && (status < 200 || status >= 300)) {
    const text = getRequestUrlText(response);
    let detail = text;
    try {
      const json = JSON.parse(text);
      detail = json && (json.error && json.error.message || json.message || json.detail) || text;
    } catch { /* intentionally empty */ }
    throw createLlmHttpError(status, detail, endpoint, response && response.headers);
  }
  return parseRequestUrlJson(response);
}

export function getLlmRequestPriority(options) {
  const raw = String((options && (options.priority || options.llmPriority)) || "").toLowerCase();
  if (/^(user|interactive|high)$/.test(raw)) return 0;
  if (/^(background|silent|low)$/.test(raw)) return 2;
  if (/^(idle|suggestion|optional)$/.test(raw)) return 3;
  return 1;
}

export function runQueuedLlmRequest(options, run) {
  const safeNotify = (name, payload) => {
    try {
      const callback = options && options[name];
      if (typeof callback === "function") callback(payload);
    } catch { /* task telemetry must never block the request */ }
  };
  if (options && options.skipQueue) {
    safeNotify("onStart", { queuedMs: 0 });
    return run();
  }
  const enqueuedAt = Date.now();
  safeNotify("onQueued", { enqueuedAt });
  return LLM_REQUEST_QUEUE.enqueue(getLlmRequestPriority(options || {}), () => {
    safeNotify("onStart", { queuedMs: Math.max(0, Date.now() - enqueuedAt) });
    return run();
  }, options && options.signal);
}

export function accumulateLlmSseDataLine(line, state) {
  const t = String(line || "").replace(/\r$/, "").trim();
  if (!t || t.indexOf("data:") !== 0) return false;
  const data = t.slice(5).trim();
  if (data === "[DONE]") { state.done = true; return false; }
  let obj;
  try { obj = JSON.parse(data); } catch { return false; }
  if (obj && obj.usage) state.usage = obj.usage;
  const choice = obj && obj.choices && obj.choices[0];
  if (choice && choice.finish_reason) state.finishReason = String(choice.finish_reason);
  const piece = choice && ((choice.delta && choice.delta.content) || (choice.message && choice.message.content));
  if (piece) { state.content += piece; return true; }
  return false;
}

export async function readLlmSseStream(res, onActivity) {
  const state = { content: "", done: false, finishReason: "", usage: null };
  let raw = "";
  // 环境不支持流式 reader：退回整体读取后按 SSE 文本逐行解析。
  if (!res.body || typeof res.body.getReader !== "function") {
    raw = await res.text();
    if (typeof onActivity === "function") onActivity();
    for (const line of String(raw).split(/\n/)) {
      accumulateLlmSseDataLine(line, state);
      if (state.done) break;
    }
    const finalized = finalizeLlmSseContent(state, raw);
    if (!state.done && !finalized.finishReason) {
      if (finalized.content) finalized.finishReason = "aborted";
      else throw new Error(t("LLM response stream interrupted: no body or end marker received"));
    }
    return finalized;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk && chunk.done) break;
      if (typeof onActivity === "function") onActivity();
      const text = decoder.decode(chunk.value, { stream: true });
      raw += text;
      buffer += text;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        accumulateLlmSseDataLine(line, state);
        if (state.done) return finalizeLlmSseContent(state, raw);
      }
    }
    if (buffer) accumulateLlmSseDataLine(buffer, state);
  } catch (e) {
    // 流被中断（空闲超时 abort / 网络断）：已收到的内容不浪费。中断本身也是一种截断，标记 aborted。
    const partial = finalizeLlmSseContent(state, raw);
    if (partial.content) { if (!partial.finishReason) partial.finishReason = "aborted"; return partial; }
    throw e;
  } finally {
    // 释放 reader：abort / 提前 return / 异常时若不释放，底层流锁与句柄会泄漏（依赖 GC 不确定回收）。
    try { reader.cancel().catch(() => { /* intentionally empty */ }); } catch { /* intentionally empty */ }
  }
  const finalized = finalizeLlmSseContent(state, raw);
  // 网络流自然关闭但既没有 [DONE]、也没有 finish_reason，同样属于不完整响应。
  // 有正文时保住已计费内容并标记 aborted，供最终纪要续写；完全为空时显式失败并进入重试。
  if (!state.done && !finalized.finishReason) {
    if (finalized.content) finalized.finishReason = "aborted";
    else throw new Error(t("LLM response stream interrupted: no body or end marker received"));
  }
  return finalized;
}

export function finalizeLlmSseContent(state, raw) {
  if (state.content) return { content: state.content, finishReason: state.finishReason || "", usage: state.usage || null };
  const trimmed = String(raw || "").trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      const c = obj && obj.choices && obj.choices[0];
      const msg = c && ((c.message && c.message.content) || (c.delta && c.delta.content));
      if (msg) return { content: msg, finishReason: (c && c.finish_reason) ? String(c.finish_reason) : "", usage: obj.usage || null };
    } catch { /* intentionally empty */ }
  }
  return { content: state.content, finishReason: state.finishReason || "", usage: state.usage || null };
}

export async function requestLlmChatCompletion(plugin, messages, options) {
  const { llmEndpoint, llmApiKey, llmModel } = plugin.settings;
  const endpoint = normalizeLlmEndpoint(llmEndpoint);
  if (!endpoint) throw new Error(t("LLM service address is not configured"));
  assertSafeServiceEndpoint(endpoint, "http", t("LLM service address"));
  if (!llmModel) throw new Error(t("LLM model name is not configured"));
  if (!llmApiKey && !canOmitServiceApiKey(endpoint)) {
    throw new Error(t("LLM API key is not configured; only local, LAN, or Tailscale private-network services may leave it blank"));
  }
  // 流式默认开启（opt-out：显式传 stream:false 才关）。流式 + 空闲超时能避免"服务端算完计费、
  // 客户端却因总超时 abort 丢结果"的浪费——这对所有 LLM 调用（merge / 大纲 / 沉淀 / 词汇 / 问答）都适用。
  // 对调用方透明：callLlm 拿到的仍是 {choices:[{message:{content}}]}，extractLlmContent 取值一致；
  // 端点若忽略 stream 参数返回普通 JSON，finalizeLlmSseContent 兜底按普通响应解析。
  const streamWanted = !(options && options.stream === false);
  const basePayload = {
    model: llmModel,
    messages,
    stream: false,
    temperature: undefined,
  };
  if (!isMoonshotKimiModel(endpoint, llmModel)) basePayload.temperature = 0.3;
  const payload = applyLearnedLlmCapability(plugin.settings, Object.assign(basePayload, options && options.payload ? options.payload : {}));
  // 思考档：default 不动请求；fast 关思维链 / reasoning 显式开——仅对已核实可控的服务注入对应参数，其它不动。
  try { applyThinkingParam(payload, (options && options.thinkingMode) || plugin.settings.thinkingMode, endpoint, llmModel); } catch { /* intentionally empty */ }
  payload.stream = streamWanted;
  const payloadText = JSON.stringify(payload);
  // Obsidian requestUrl 兜底不支持流式，单独准备一份 stream:false 的 payload 给它用。
  const fallbackPayloadText = streamWanted ? JSON.stringify(Object.assign({}, payload, { stream: false })) : payloadText;
  const messageChars = countLlmMessageChars(messages);
  const payloadChars = payloadText.length;
  const headers = buildLlmHeaders(llmApiKey, endpoint);
  const timeoutMs = resolveLlmRequestTimeoutMs(options || {});
  return await runQueuedLlmRequest(options || {}, async () => {
    const externalSignal = options && options.signal;
    if (prefersObsidianRequestUrl(endpoint)) {
      if (externalSignal && externalSignal.aborted) {
        const err = new Error(t("LLM request cancelled"));
        err.name = "AbortError";
        throw err;
      }
      await logLlmRequestDiagnostic(plugin, "info", "llm.requesturl_preferred", t("This endpoint already uses Obsidian requestUrl directly"), {
        endpoint,
        model: llmModel ? "<set>" : "",
        messageChars,
        payloadChars,
      });
      const directData = await requestLlmChatCompletionViaObsidian(endpoint, headers, fallbackPayloadText, timeoutMs);
      try {
        if (options && typeof options.onActivity === "function") options.onActivity();
      } catch { /* task telemetry must never block the request */ }
      return directData;
    }
    const controller = (timeoutMs > 0 || externalSignal) && typeof AbortController !== "undefined"
      ? new AbortController()
      : null;
    const onExternalAbort = () => { try { controller?.abort(); } catch { /* intentionally empty */ } };
    if (externalSignal && typeof externalSignal.addEventListener === "function") {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      if (externalSignal.aborted) onExternalAbort();
    }
    const detachExternalAbort = () => {
      try { externalSignal?.removeEventListener?.("abort", onExternalAbort); } catch { /* intentionally empty */ }
    };
    let timer = null;
    // 空闲超时：流式读取时每收到一个 chunk 都调 armTimer 重置；只有 timeoutMs 内"完全没有新数据"
    // 才视为真卡死并 abort。这样慢但在持续输出的响应不会被误杀、不会白白浪费已计费的生成。
    const armTimer = () => {
      if (!controller || !(timeoutMs > 0)) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => controller.abort(), timeoutMs);
    };
    const reportResponseActivity = () => {
      armTimer();
      try {
        if (options && typeof options.onActivity === "function") options.onActivity();
      } catch { /* task telemetry must never block response reading */ }
    };
    armTimer();
    let res;
    try {
      // 用 window.fetch（行为同 fetch、避开 no-restricted-globals）：LLM 流式需要 ReadableStream + AbortController；下方 requestUrl 回退仅非流式。
      res = await window.fetch(endpoint, {
        method: "POST",
        headers,
        body: payloadText,
        signal: controller ? controller.signal : undefined,
      });
    } catch (e) {
      if (timer) window.clearTimeout(timer);
      detachExternalAbort();
      if (controller && controller.signal && controller.signal.aborted) {
        const cancelled = !!(externalSignal && externalSignal.aborted);
        const err = new Error(cancelled
          ? t("LLM request cancelled")
          : t("LLM request timed out: no response within {0} seconds").replace("{0}", String(Math.round(timeoutMs / 1000))));
        if (cancelled) err.name = "AbortError";
        await logLlmRequestDiagnostic(
          plugin,
          cancelled ? "info" : "error",
          cancelled ? "llm.request_cancelled" : "llm.fetch_failed",
          cancelled ? t("LLM request cancelled") : t("Failed to send the LLM request"),
          {
          endpoint,
          model: llmModel ? "<set>" : "",
          messageChars,
          payloadChars,
          timeoutMs,
          aborted: true,
          cancelled,
          error: diagnosticError(err),
          }
        );
        throw err;
      }
      await logLlmRequestDiagnostic(plugin, "error", "llm.fetch_failed", t("Failed to send the LLM request"), {
        endpoint,
        model: llmModel ? "<set>" : "",
        messageChars,
        payloadChars,
        timeoutMs,
        aborted: false,
        error: diagnosticError(e),
      });
      await logLlmRequestDiagnostic(plugin, "warn", "llm.requesturl_fallback_start", t("fetch failed; falling back to Obsidian requestUrl"), {
        endpoint,
        model: llmModel ? "<set>" : "",
        messageChars,
        payloadChars,
        fetchError: diagnosticError(e),
      });
      try {
        const fallbackData = await requestLlmChatCompletionViaObsidian(endpoint, headers, fallbackPayloadText, timeoutMs);
        rememberObsidianRequestUrlPreference(endpoint);
        await logLlmRequestDiagnostic(plugin, "info", "llm.requesturl_fallback_succeeded", t("Obsidian requestUrl fallback succeeded"), {
          endpoint,
          model: llmModel ? "<set>" : "",
          messageChars,
          payloadChars,
        });
        return fallbackData;
      } catch (fallbackError) {
        await logLlmRequestDiagnostic(plugin, "error", "llm.requesturl_fallback_failed", t("Obsidian requestUrl fallback failed"), {
          endpoint,
          model: llmModel ? "<set>" : "",
          messageChars,
          payloadChars,
          fetchError: diagnosticError(e),
          fallbackError: diagnosticError(fallbackError),
        });
        throw pickLlmRequestError(e, fallbackError);
      }
    }
    // fetch 已成功返回（连接已建立）。读取响应期间继续用空闲计时器保护；流式时每个 chunk 都会重置它。
    try {
      if (!res.ok) {
        const msg = await readLlmError(res);
        if (shouldRetryTokenPlanParamError(res.status, msg, endpoint)) {
          const retryPayload = makeTokenPlanCompatPayload(payload);
          const retryPayloadText = JSON.stringify(retryPayload);
          await logLlmRequestDiagnostic(plugin, "warn", "llm.token_plan_param_retry", "Token-plan returned a parameter error; retrying with a minimal compatible payload", {
            endpoint,
            model: llmModel ? "<set>" : "",
            status: res.status,
            messageChars,
            payloadChars,
            retryPayloadChars: retryPayloadText.length,
            statusDetail: msg,
          });
          const retryData = await requestLlmChatCompletionViaObsidian(endpoint, headers, retryPayloadText, timeoutMs);
          await logLlmRequestDiagnostic(plugin, "info", "llm.token_plan_param_retry_succeeded", "Token-plan compatible payload retry succeeded", {
            endpoint,
            model: llmModel ? "<set>" : "",
            messageChars,
            payloadChars,
            retryPayloadChars: retryPayloadText.length,
          });
          return retryData;
        }
        await logLlmRequestDiagnostic(plugin, "error", "llm.http_failed", t("The LLM returned a non-success status"), {
          endpoint,
          model: llmModel ? "<set>" : "",
          status: res.status,
          messageChars,
          payloadChars,
          statusDetail: msg,
          retryAfterMs: getLlmRetryAfterMsFromHeaders(res.headers),
        });
        throw createLlmHttpError(res.status, msg, endpoint, res.headers);
      }
      if (streamWanted) {
        armTimer(); // 给"首个 token 到达"一个完整的空闲窗口
        const { content, finishReason, usage } = await readLlmSseStream(res, reportResponseActivity);
        // 透传 finish_reason，让上层能检测"length"截断（流式重包此前会把它丢掉 → 截断无从察觉）。
        return { choices: [{ message: { role: "assistant", content }, finish_reason: finishReason || null }], usage: usage || undefined };
      }
      const json = await res.json();
      reportResponseActivity();
      return json;
    } catch (e) {
      // HTTP 状态错误已在上方完整记录并带 status/nonRetryable 语义，不能再误记成响应读取错误。
      if (e && e.status) throw e;
      const cancelled = !!(externalSignal && externalSignal.aborted);
      if (controller && controller.signal && controller.signal.aborted) {
        const err = new Error(cancelled
          ? t("LLM request cancelled")
          : t("LLM request timed out: no new data within {0} seconds").replace("{0}", String(Math.round(timeoutMs / 1000))));
        if (cancelled) err.name = "AbortError";
        await logLlmRequestDiagnostic(
          plugin,
          cancelled ? "info" : "error",
          cancelled ? "llm.request_cancelled" : "llm.response_timeout",
          cancelled ? t("LLM request cancelled") : t("Timed out reading the LLM response"),
          {
            endpoint,
            model: llmModel ? "<set>" : "",
            messageChars,
            payloadChars,
            timeoutMs,
            cancelled,
            error: diagnosticError(err),
          }
        );
        throw err;
      }
      await logLlmRequestDiagnostic(plugin, "error", "llm.response_read_failed", t("Failed to read the LLM response"), {
        endpoint,
        model: llmModel ? "<set>" : "",
        messageChars,
        payloadChars,
        timeoutMs,
        error: diagnosticError(e),
      });
      throw e;
    } finally {
      if (timer) window.clearTimeout(timer);
      detachExternalAbort();
    }
  });
}

export async function testLlmConnection(plugin) {
  const data = await requestLlmChatCompletion(plugin, [
    { role: "system", content: "You are a connectivity test endpoint. Reply with OK only." },
    { role: "user", content: "QnALog connection test. Reply OK." },
  ], {});
  return {
    endpoint: normalizeLlmEndpoint(plugin.settings.llmEndpoint),
    model: plugin.settings.llmModel,
    preview: extractLlmContent(data).trim().slice(0, 40),
  };
}

export function isTransientLlmError(error) {
  if (isLlmNonRetryableError(error)) return false;
  if (error && error.name === "AbortError") return false;
  const msg = String((error && error.message) || error || "");
  return /Failed to fetch|network|ECONNRESET|ETIMEDOUT|timeout|timed?\s*out|\b(429|500|502|503|504|529)\b|rate\s*limit|temporarily|service unavailable|overloaded|超时|响应流中断|stream interrupted/i.test(msg);
}

export function getLlmRetryDelayMs(error, attemptIndex) {
  const hinted = Number(error && error.retryAfterMs);
  const jitter = Math.floor(Math.random() * 300);
  const fallback = 1000 * Math.pow(2, Math.max(0, Number(attemptIndex) || 0)) + jitter;
  const raw = Number.isFinite(hinted) && hinted > 0 ? Math.max(hinted, 250 + jitter) : fallback;
  return Math.max(250, Math.min(60 * 1000, Math.round(raw)));
}

export function resolveLlmModelListEndpoint(endpoint) {
  const base = normalizeLlmEndpoint(endpoint);
  if (!base) throw new Error(t("Service address is not configured"));
  try {
    const url = new URL(base);
    const host = url.hostname.toLowerCase();
    const isBailianWorkspace = host === "dashscope.aliyuncs.com"
      || (host.endsWith(".maas.aliyuncs.com") && !host.startsWith("token-plan."));
    if (isBailianWorkspace && /\/compatible-mode\/v1(?:\/chat\/completions)?$/i.test(url.pathname)) {
      url.pathname = "/api/v1/models";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/+$/, "");
    }
  } catch { /* fall through to the OpenAI-compatible endpoint */ }
  return /\/chat\/completions$/i.test(base)
    ? base.replace(/\/chat\/completions$/i, "/models")
    : base.replace(/\/+$/, "") + "/models";
}

/** 模型列表条目：id 必有；type 是部分平台附带的分类字段（llm/asr/…）；
 * outputModalities 是输出模态（text/image/video/audio，小写）——百炼取
 * inference_metadata.response_modality，OpenRouter 取 architecture.output_modalities；
 * description 是平台描述，用于说话人分离这类「描述里写明能力」的候选筛选。
 * 不解析输入模态：「能听音频」是理解型 chat 模型的属性，不代表能走转写端点，
 * 曾据此扩过转写候选，实测把 OpenRouter 的 49 个文本模型全放了进来，已撤。 */
export interface LlmModelEntry {
  id: string;
  type?: string;
  outputModalities?: string[];
  capabilities?: string[];
  description?: string;
}

/** 从多种响应形态里取模型条目：OpenAI 形态 data/models，百炼原生形态 output.models
 * （条目字段是 model + name——id 取值必须 model 优先于 name，name 是展示名不是标识）。 */
function parseModelEntries(payload): LlmModelEntry[] {
  const candidates = [
    payload && payload.data,
    payload && payload.models,
    payload && payload.output && payload.output.models,
    payload && payload.output && payload.output.model_list,
    payload && payload.results,
    payload && payload.data && payload.data.models,
    payload && payload.data && payload.data.model_list,
    payload,
  ];
  const arr = candidates.find((c) => Array.isArray(c)) || [];
  return (Array.isArray(arr) ? arr : [])
    .map((m) => {
      if (typeof m === "string") return m.trim() ? { id: m.trim() } : null;
      const id = String((m && (m.id || m.model || m.model_name || m.name)) || "").trim();
      if (!id) return null;
      const type = m && typeof m.type === "string" ? m.type.trim().toLowerCase() : "";
      const outputRaw = m && (
        (m.inference_metadata && m.inference_metadata.response_modality)
        || (m.architecture && m.architecture.output_modalities)
        || m.output_modalities
      );
      const lowerList = (raw) => (Array.isArray(raw) ? raw.map((x) => String(x || "").toLowerCase()).filter(Boolean) : []);
      const outputModalities = lowerList(outputRaw);
      const rawCapabilities = m && m.capabilities;
      const capabilities = Array.isArray(rawCapabilities)
        ? rawCapabilities.map((value) => String(value || "").trim()).filter(Boolean)
        : rawCapabilities && typeof rawCapabilities === "object"
          ? Object.entries(rawCapabilities).filter(([, enabled]) => Boolean(enabled)).map(([key]) => key)
          : typeof rawCapabilities === "string" ? [rawCapabilities] : [];
      const description = m && typeof m.description === "string" ? m.description.slice(0, 800) : "";
      return {
        id,
        ...(type ? { type } : {}),
        ...(outputModalities.length ? { outputModalities } : {}),
        ...(capabilities.length ? { capabilities } : {}),
        ...(description ? { description } : {}),
      };
    })
    .filter(Boolean);
}

/** 百炼目录按 page_no/page_size 分页。完整目录请求显式使用平台支持的 100 条上限，
 * 减少逐页请求触发频率限制的机会；后续分页仍严格依据响应里的总数与页大小。 */
function withModelListPage(url: string, pageNo: number, pageSize: number): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("page_no", String(pageNo));
    parsed.searchParams.set("page_size", String(pageSize));
    return parsed.toString();
  } catch {
    return url;
  }
}

export interface FetchLlmModelEntriesOptions {
  requireCompletePagination?: boolean;
}

export async function fetchLlmModelEntries(
  endpoint,
  apiKey,
  extraQuery?: Record<string, string>,
  options: FetchLlmModelEntriesOptions = {},
): Promise<LlmModelEntry[]> {
  const base = normalizeLlmEndpoint(endpoint);
  if (!base) throw new Error(t("Service address is not configured"));
  assertSafeServiceEndpoint(base, "http", t("LLM service address"));
  const requireCompletePagination = options.requireCompletePagination === true;
  const genericUrl = /\/chat\/completions$/i.test(base)
    ? base.replace(/\/chat\/completions$/i, "/models")
    : base.replace(/\/+$/, "") + "/models";
  const withQuery = (url: string) => {
    if (!extraQuery || !Object.keys(extraQuery).length) return url;
    try {
      const parsed = new URL(url);
      for (const [key, value] of Object.entries(extraQuery)) parsed.searchParams.set(key, value);
      return parsed.toString();
    } catch {
      return url;
    }
  };
  const urls = [withQuery(resolveLlmModelListEndpoint(endpoint))];
  const genericQueried = withQuery(genericUrl);
  if (!urls.includes(genericQueried)) urls.push(genericQueried);
  const headers = buildLlmHeaders(apiKey, base);
  delete headers["Content-Type"];
  const problems: string[] = [];
  for (const url of urls) {
    const byId = new Map<string, LlmModelEntry>();
    const urlProblems: string[] = [];
    let pageNo = 1;
    let pageSize = 0;
    let expectedTotal: number | null = null;
    let complete = false;
    const firstPageUrl = requireCompletePagination ? withModelListPage(url, 1, 100) : url;
    for (let page = 0; page < 100; page += 1) {
      const pageUrl = pageNo === 1 ? firstPageUrl : withModelListPage(url, pageNo, pageSize || 100);
      const res = await obsidian.requestUrl({ url: pageUrl, method: "GET", headers, throw: false });
      if (res.status < 200 || res.status >= 300) {
        urlProblems.push(t("{0} → HTTP status {1}: {2}").replace("{0}", pageUrl).replace("{1}", String(res.status)).replace("{2}", String(res.text || "").slice(0, 200)));
        break;
      }
      let data;
      try { data = res.json || JSON.parse(res.text || "{}"); } catch {
        urlProblems.push(t("{0} → Response is not valid JSON").replace("{0}", pageUrl));
        break;
      }
      const before = byId.size;
      for (const entry of parseModelEntries(data)) {
        if (!byId.has(entry.id)) byId.set(entry.id, entry);
      }
      const output = data && data.output;
      const total = Number(output && output.total);
      const reportedPage = Number(output && output.page_no);
      pageSize = Number(output && output.page_size) || 0;
      if (requireCompletePagination) {
        if (!Number.isInteger(total) || total < 0 || !Number.isInteger(reportedPage) || reportedPage !== pageNo || !Number.isInteger(pageSize) || pageSize < 1) {
          urlProblems.push(t("{0} → Pagination metadata is missing or invalid").replace("{0}", pageUrl));
          break;
        }
        if (expectedTotal === null) expectedTotal = total;
        if (total !== expectedTotal || (byId.size === before && byId.size < expectedTotal)) {
          urlProblems.push(t("{0} → Model list pagination did not make progress or changed total count").replace("{0}", pageUrl));
          break;
        }
        if (byId.size >= expectedTotal) {
          complete = true;
          break;
        }
      } else if (!total || !pageSize || byId.size >= total || byId.size === before) {
        complete = true;
        break;
      }
      pageNo += 1;
    }
    if (requireCompletePagination && !complete && !urlProblems.length) {
      urlProblems.push(t("{0} → Model list exceeded the maximum page count").replace("{0}", url));
    }
    if (complete && (!requireCompletePagination || byId.size === expectedTotal)) {
      return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    problems.push(...(urlProblems.length ? urlProblems : [t("{0} → No complete model list returned").replace("{0}", url)]));
  }
  throw new Error(problems.join(t("; ")) || t("Failed to fetch the model list"));
}

export async function fetchLlmModelList(endpoint, apiKey): Promise<string[]> {
  return (await fetchLlmModelEntries(endpoint, apiKey)).map((entry) => entry.id);
}

export function getLlmConfigIssue(settings) {
  const endpoint = normalizeLlmEndpoint(settings && settings.llmEndpoint);
  const model = String((settings && settings.llmModel) || "").trim();
  const apiKey = String((settings && settings.llmApiKey) || "").trim();
  if (!endpoint) return t("LLM service address is not configured");
  const endpointSecurityIssue = getServiceEndpointSecurityIssue(endpoint, "http", t("LLM service address"));
  if (endpointSecurityIssue) return endpointSecurityIssue;
  if (!model) return t("LLM model name is not configured");
  if (!apiKey && !canOmitServiceApiKey(endpoint)) return t("LLM API key is not configured; only local, LAN, or Tailscale private-network services may leave it blank");
  return "";
}


// 只有服务端明确说输出预算不被接受时才降档；普通上下文超限、鉴权失败和网络错误不走这条路径。
// 这样新模型可以先按实际需求请求更大的输出，旧模型仍能在真实拒绝后兼容，而不是事先被模型名猜测绑死。
export function isLlmOutputBudgetError(error) {
  const status = Number(error && error.status) || 0;
  if (status !== 400) return false;
  const message = String((error && (error.statusDetail || error.message)) || error || "");
  if (isLlmContextLimitError(error) && !/max[_ -]?tokens|max(?:imum)?[_ -]?(?:completion|output)[_ -]?tokens|output[_ -]?token/i.test(message)) return false;
  return /max[_ -]?tokens|max(?:imum)?[_ -]?(?:completion|output)[_ -]?tokens|output[_ -]?token(?:s)?|too many tokens|token limit|生成长度|输出长度|输出 token/i.test(message);
}

export function isLlmOutputParameterError(error) {
  const status = Number(error && error.status) || 0;
  if (status !== 400) return false;
  const message = String((error && (error.statusDetail || error.message)) || error || "");
  const mentionsMaxTokens = /max[_ -]?tokens/i.test(message);
  const rejectsParameter = /unsupported|not supported|unknown|unrecognized|unexpected|not allowed|does not accept|不支持|未知参数/i.test(message);
  const looksLikeValueLimit = /too large|too many|maximum|limit|超过上限|长度过大|数量过多/i.test(message);
  return mentionsMaxTokens && rejectsParameter && !looksLikeValueLimit;
}

// 这些值只用于服务端明确拒绝预算后的兼容重试，不是正常输出的全局上限。
const OUTPUT_BUDGET_FALLBACKS = [384000, 256000, 192000, 128000, 64000, 32000, 16000, 8192, 4096];
const MAX_OUTPUT_BUDGET_ATTEMPTS = OUTPUT_BUDGET_FALLBACKS.length + 2;

export function getNextLlmOutputBudget(options) {
  const requested = getLlmOutputBudgetFromOptions(options);
  if (!Number.isFinite(requested) || requested <= 4096) return 0;
  return OUTPUT_BUDGET_FALLBACKS.find((value) => value < requested) || 4096;
}

export async function requestLlmChatCompletionWithBudgetFallback(plugin, messages, options) {
  let currentOptions = options || {};
  let parameterFallbackUsed = false;
  let budgetFallbackUsed = false;
  // 覆盖首次请求、一次参数名兼容切换，以及全部有限降档，不会无限重试。
  for (let attempt = 0; attempt < MAX_OUTPUT_BUDGET_ATTEMPTS; attempt++) {
    try {
      const effectiveBudget = getEffectiveLlmOutputBudget(plugin && plugin.settings, currentOptions);
      const result = await requestLlmChatCompletion(plugin, messages, currentOptions);
      // 只有“服务端拒绝较大预算后降档成功”才记忆上限。
      // 普通成功请求不能证明这是服务端的最大能力，否则一次 48K 成功会错误封顶后续 128K 请求。
      if (budgetFallbackUsed && effectiveBudget > 0) rememberLlmOutputCeiling(plugin && plugin.settings, effectiveBudget);
      if (parameterFallbackUsed) {
        rememberLlmOutputParameter(plugin && plugin.settings, "max_completion_tokens");
      }
      return result;
    } catch (error) {
      if (isLlmOutputParameterError(error) && !parameterFallbackUsed) {
        const requested = getLlmOutputBudgetFromOptions(currentOptions);
        parameterFallbackUsed = true;
        await logLlmRequestDiagnostic(plugin, "warn", "llm.output_parameter_fallback", t("The server rejected max_tokens; switched to max_completion_tokens and retried"), {
          requested,
          attempt: attempt + 1,
        });
        const payload = Object.assign({}, currentOptions.payload || {});
        if (payload.max_tokens != null && payload.max_completion_tokens == null) {
          payload.max_completion_tokens = payload.max_tokens;
          delete payload.max_tokens;
        }
        currentOptions = Object.assign({}, currentOptions, { payload });
        continue;
      }
      if (!isLlmOutputBudgetError(error)) throw error;
      const nextBudget = getNextLlmOutputBudget(currentOptions);
      if (!nextBudget) throw error;
      budgetFallbackUsed = true;
      const requested = getLlmOutputBudgetFromOptions(currentOptions);
      await logLlmRequestDiagnostic(plugin, "warn", "llm.output_budget_fallback", t("The server rejected the current output budget; lowered it to the actual capability and retried"), {
        requested,
        retryBudget: nextBudget,
        attempt: attempt + 1,
      });
      const payload = Object.assign({}, currentOptions.payload || {});
      if (payload.max_completion_tokens != null) payload.max_completion_tokens = nextBudget;
      else payload.max_tokens = nextBudget;
      currentOptions = Object.assign({}, currentOptions, {
        payload,
      });
    }
  }
  throw new Error(t("The LLM output budget retry count is exhausted"));
}

export function formatLlmConfigIssue(issue) {
  const text = String(issue || "").trim();
  if (!text) return "";
  if (/请到「设置|Settings → API/.test(text)) return text;
  return t("{0}. Please complete it under Settings → API → AI organizing service, then test the connection.").replace("{0}", text);
}

export function formatLlmFailureIssue(issue) {
  const text = String(issue || "").trim();
  if (!text) return "";
  if (isLlmConfigError(text)) return formatLlmConfigIssue(text);
  if (isLlmServiceBlockedError(text)) {
    return t("{0}. This is a problem returned by the LLM service or account pool, not caused by text length, ASR, or the text-import path; switch the model/endpoint, or retry manually later.").replace("{0}", text);
  }
  return text;
}

export function isTruncatedFinishReason(reason) {
  return reason === "length" || reason === "aborted" || reason === "max_tokens" || reason === "content_filter";
}

export function extractLlmFinishReason(data) {
  const c = data && data.choices && data.choices[0];
  return c && c.finish_reason ? String(c.finish_reason) : "";
}

export async function callLlmWithMeta(plugin, system, user, options) {
  let data;
  let lastError = null;
  const attempts = (options && options.noRetry) ? 1 : 2;
  for (let i = 0; i < attempts; i++) {
    try {
      data = await requestLlmChatCompletionWithBudgetFallback(plugin, [
        { role: "system", content: system },
        { role: "user", content: user },
      ], options);
      break;
    } catch (e) {
      lastError = e;
      if (i >= attempts - 1 || !isTransientLlmError(e)) throw e;
      await delayMs(getLlmRetryDelayMs(e, i));
    }
  }
  if (!data && lastError) throw lastError;
  const text = stripModeSuggestionBlocks(extractLlmContent(data).trim());
  const usage = (data && data.usage) ? data.usage : null;
  // 单任务 token 计量：把每次 LLM 调用的输入/输出体量喂给插件计量器（仅在任务窗口内累计；空闲时 no-op）。
  // 流式响应通常不带 usage（这里 usage=null），由计量器按字符估算；非流式有 usage 时取精确值。
  try {
    if (plugin && plugin.tasks && typeof plugin.tasks.addTaskMeter === "function") {
      plugin.tasks.addTaskMeter(String(system || "").length + String(user || "").length, text.length, usage, options && options.taskMeter);
    }
  } catch { /* intentionally empty */ }
  return { text, finishReason: extractLlmFinishReason(data), usage };
}

export async function callLlm(plugin, system, user, options = null) {
  const { text } = await callLlmWithMeta(plugin, system, user, options);
  return text;
}

// 续写衔接：若续写片段开头与已有结尾有重叠，去掉重叠再拼，避免模型重复一段。
function stitchContinuation(a, b) {
  const head = String(a || "");
  const tail = String(b || "");
  if (!head) return tail;
  if (!tail) return head;
  const maxOverlap = Math.min(400, head.length, tail.length);
  for (let k = maxOverlap; k >= 16; k--) {
    if (head.slice(-k) === tail.slice(0, k)) return head + tail.slice(k);
  }
  return head + tail;
}

function normalizeLlmUsage(usage) {
  const raw = usage && typeof usage === "object" ? usage : {};
  const promptTokens = Math.max(0, Number(raw.prompt_tokens ?? raw.input_tokens) || 0);
  const completionTokens = Math.max(0, Number(raw.completion_tokens ?? raw.output_tokens) || 0);
  const reasoningTokens = Math.max(0, Number(
    raw.reasoning_tokens
      ?? (raw.completion_tokens_details && raw.completion_tokens_details.reasoning_tokens)
      ?? (raw.output_tokens_details && raw.output_tokens_details.reasoning_tokens),
  ) || 0);
  const totalTokens = Math.max(0, Number(raw.total_tokens) || (promptTokens + completionTokens));
  return { promptTokens, completionTokens, reasoningTokens, totalTokens };
}

function addLlmUsage(left, right) {
  const a = left || normalizeLlmUsage(null);
  const b = normalizeLlmUsage(right);
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

// 截断自动续写：当一次输出因 finishReason==="length" 被截断时，用「assistant 预填 + 让它从断点续写」
// 的方式再发请求，把多段拼成完整产物——不让偶发的模型输出上限决定内容完整性。
// 工程兜底，与 mergeAndPolishLongSession 的「事前按时间分段」互补：那条防"明显超长"，这条防"偶发被切"。
export async function callLlmWithContinuation(plugin, system, user, options, opts) {
  const rawMaxContinuations = opts && Object.prototype.hasOwnProperty.call(opts, "maxContinuations")
    ? Number(opts.maxContinuations)
    : NaN;
  const maxContinuations = Number.isFinite(rawMaxContinuations)
    ? Math.max(0, Math.floor(rawMaxContinuations))
    : 3;
  let effectiveOptions = options || {};
  let first = await callLlmWithMeta(plugin, system, user, effectiveOptions);
  let text = String(first.text || "");
  let finishReason = first.finishReason;
  let usage = addLlmUsage(null, first.usage);
  let continuations = 0;
  let continuationAttempts = 0;
  // 推理 token 耗尽但没有可见正文时，不能拿空 assistant 消息续写；先用 fast 档重跑一次原始请求。
  // 这是针对推理模型的恢复分支，正常有正文的截断不改变原有续写行为。
  if (isTruncatedFinishReason(finishReason) && !text.trim() && effectiveOptions.thinkingMode !== "fast") {
    const fastOptions = Object.assign({}, effectiveOptions, { thinkingMode: "fast" });
    try {
      await logLlmRequestDiagnostic(plugin, "warn", "llm.empty_truncated_fast_retry", t("The model exhausted its output budget but returned no body text; deep thinking has been disabled and the request retried"), {});
      first = await callLlmWithMeta(plugin, system, user, fastOptions);
      effectiveOptions = fastOptions;
      text = String(first.text || "");
      finishReason = first.finishReason;
      usage = addLlmUsage(usage, first.usage);
    } catch (error) {
      try {
        await logLlmRequestDiagnostic(plugin, "warn", "llm.empty_truncated_fast_retry_failed", t("The recovery request with deep thinking disabled failed for empty body text"), {
          error: diagnosticError(error),
        });
      } catch { /* intentionally empty */ }
      // 继续走有界的空正文恢复；失败时由上层保留原始转写并报告原因。
    }
  }
  while (isTruncatedFinishReason(finishReason) && continuationAttempts < maxContinuations) {
    continuationAttempts++;
    const messages = text.trim()
      ? [
        { role: "system", content: system },
        { role: "user", content: user },
        { role: "assistant", content: text },
        { role: "user", content: "你上一条回复因长度上限被截断了。请直接从断点处继续输出剩余内容、无缝衔接，不要重复任何已输出的文字、不要重新开头、不要加任何前言或结束语，直接接着写。" },
      ]
      : [
        { role: "system", content: system },
        { role: "user", content: `${user}\n\n上一次生成因思考或输出过长被截断，且没有产生可见正文。请直接完整回答原始任务，不要提及截断，不要加前言。` },
      ];
    let data;
    try {
      data = await requestLlmChatCompletionWithBudgetFallback(plugin, messages, effectiveOptions);
    } catch (error) {
      try {
        await logLlmRequestDiagnostic(plugin, "warn", "llm.continuation_failed", t("Continuation request failed; the existing body text has been kept"), {
          attempt: continuationAttempts,
          hadVisibleText: !!text.trim(),
          error: diagnosticError(error),
        });
      } catch { /* intentionally empty */ }
      break; // 续写失败就用已有内容，不让整体失败
    }
    const piece = stripModeSuggestionBlocks(extractLlmContent(data).trim());
    usage = addLlmUsage(usage, data && data.usage);
    try {
      if (plugin && plugin.tasks && typeof plugin.tasks.addTaskMeter === "function") {
        plugin.tasks.addTaskMeter(messages.reduce((n, m) => n + String(m.content || "").length, 0), piece.length, (data && data.usage) || null, effectiveOptions && effectiveOptions.taskMeter);
      }
    } catch { /* intentionally empty */ }
    if (!piece) {
      try {
        await logLlmRequestDiagnostic(plugin, "warn", "llm.continuation_empty", t("The continuation still returned no visible body text"), {
          attempt: continuationAttempts,
          finishReason: extractLlmFinishReason(data),
          hadVisibleText: !!text.trim(),
        });
      } catch { /* intentionally empty */ }
      break;
    }
    text = stitchContinuation(text, piece);
    continuations++;
    finishReason = extractLlmFinishReason(data);
  }
  return { text, finishReason, truncated: isTruncatedFinishReason(finishReason), continuations, continuationAttempts, usage };
}

export async function callBriefingMergeLlm(plugin, system, user, options, diagCtx) {
  const rawMaxContinuations = options && Object.prototype.hasOwnProperty.call(options, "maxContinuations")
    ? Number(options.maxContinuations)
    : NaN;
  const maxContinuations = Number.isFinite(rawMaxContinuations)
    ? Math.max(0, Math.floor(rawMaxContinuations))
    : 3;
  const { text, finishReason, continuations, continuationAttempts, usage } = await callLlmWithContinuation(plugin, system, user, options, { maxContinuations });
  const truncated = isTruncatedFinishReason(finishReason);
  if (!String(text || "").trim()) {
    try {
      await logLlmRequestDiagnostic(plugin, "warn", "llm.merge_empty_output", t("The LLM request completed but returned no visible body text"), Object.assign({
        finishReason: finishReason || "",
        continuations,
        continuationAttempts,
      }, diagCtx || {}));
    } catch { /* intentionally empty */ }
  }
  if (continuations > 0) {
    try {
      await logLlmRequestDiagnostic(plugin, "info", "llm.merge_continued", t("Automatically continued and stitched after truncated output"), Object.assign({
        continuations, truncatedAfter: truncated, outputChars: text.length,
      }, diagCtx || {}));
    } catch { /* intentionally empty */ }
  }
  if (truncated) {
    try {
      await logLlmRequestDiagnostic(plugin, "warn", "llm.merge_truncated", t("The final minutes still appear truncated by the output length limit after multiple continuations"), Object.assign({
        finishReason, outputChars: text.length, continuations, continuationAttempts,
      }, diagCtx || {}));
    } catch { /* intentionally empty */ }
  }
  return { text, truncated, finishReason, usage };
}

export function stripModeSuggestionBlocks(text) {
  if (!text) return "";
  return String(text)
    .replace(/\n{0,2}> \[!tip\] 模式建议(?:\r?\n>.*)*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
