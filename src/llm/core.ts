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
import {
  applyLearnedLlmCapability,
  getEffectiveLlmOutputBudget,
  getLlmOutputBudgetFromOptions,
  rememberLlmOutputCeiling,
  rememberLlmOutputParameter,
} from './output-budget';
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
    hint = "Poe 的 model 必须填写 Poe bot 名，且区分大小写；请点「获取可用模型」从列表中选择。";
  } else if (code === 401 || code === 403) {
    hint = "请检查 Poe API Key 是否有效，且已按 Bearer token 使用。";
  } else if (code === 402) {
    hint = "Poe 积分或订阅额度不足，请到 Poe 账户检查额度。";
  } else if (code === 413) {
    hint = "本次请求上下文可能超过 Poe 目标 bot 的限制，请缩短输入或换更长上下文的 bot。";
  } else if (code === 429 || code === 503 || code === 529) {
    hint = "Poe 当前限流或服务繁忙；Q&A Log 会按服务端 Retry-After 退避后重试一次。";
  }
  if (!hint) return base;
  return base ? `${base}。${hint}` : hint;
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
  const err = new Error(`LLM 调用失败 ${status}：${cleanDetail}`) as LlmHttpError;
  err.status = status;
  err.statusDetail = cleanDetail;
  err.retryAfterMs = getLlmRetryAfterMsFromHeaders(headers);
  err.nonRetryable = isNonRetryableLlmHttpFailure(status, cleanDetail);
  return err;
}

export function pickLlmRequestError(fetchError, fallbackError) {
  const fallbackMessage = String((fallbackError && fallbackError.message) || fallbackError || "");
  const fetchMessage = String((fetchError && fetchError.message) || fetchError || "");
  if (fallbackError && (fallbackError.status || /LLM 调用失败\s+\d+/.test(fallbackMessage))) return fallbackError;
  if (/Obsidian requestUrl 不可用/.test(fallbackMessage)) return fetchError;
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
  assertSafeServiceEndpoint(endpoint, "http", "大模型服务地址");
  if (!obsidian || typeof obsidian.requestUrl !== "function") {
    throw new Error("Obsidian requestUrl 不可用");
  }
  const request = obsidian.requestUrl({
    url: endpoint,
    method: "POST",
    headers,
    body: payloadText,
    throw: false,
  });
  const response = await withPromiseTimeout(request, timeoutMs, () => {
    const error = new Error(`LLM 兜底调用超时：${Math.round(timeoutMs / 1000)} 秒内没有响应`) as LlmHttpError;
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
      else throw new Error("LLM 响应流中断：未收到正文或结束标记");
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
    else throw new Error("LLM 响应流中断：未收到正文或结束标记");
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
  if (!endpoint) throw new Error("大模型服务地址未配置");
  assertSafeServiceEndpoint(endpoint, "http", "大模型服务地址");
  if (!llmModel) throw new Error("大模型名称未配置");
  if (!llmApiKey && !canOmitServiceApiKey(endpoint)) {
    throw new Error("大模型访问密钥未配置；只有本地、局域网或 Tailscale 等私有网络服务可以留空");
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
        const err = new Error("LLM 调用已取消");
        err.name = "AbortError";
        throw err;
      }
      await logLlmRequestDiagnostic(plugin, "info", "llm.requesturl_preferred", "此端点已直接使用 Obsidian requestUrl", {
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
          ? "LLM 调用已取消"
          : `LLM 调用超时：${Math.round(timeoutMs / 1000)} 秒内没有响应`);
        if (cancelled) err.name = "AbortError";
        await logLlmRequestDiagnostic(
          plugin,
          cancelled ? "info" : "error",
          cancelled ? "llm.request_cancelled" : "llm.fetch_failed",
          cancelled ? "LLM 请求已取消" : "LLM 请求发送失败",
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
      await logLlmRequestDiagnostic(plugin, "error", "llm.fetch_failed", "LLM 请求发送失败", {
        endpoint,
        model: llmModel ? "<set>" : "",
        messageChars,
        payloadChars,
        timeoutMs,
        aborted: false,
        error: diagnosticError(e),
      });
      await logLlmRequestDiagnostic(plugin, "warn", "llm.requesturl_fallback_start", "fetch 失败后尝试 Obsidian requestUrl 兜底", {
        endpoint,
        model: llmModel ? "<set>" : "",
        messageChars,
        payloadChars,
        fetchError: diagnosticError(e),
      });
      try {
        const fallbackData = await requestLlmChatCompletionViaObsidian(endpoint, headers, fallbackPayloadText, timeoutMs);
        rememberObsidianRequestUrlPreference(endpoint);
        await logLlmRequestDiagnostic(plugin, "info", "llm.requesturl_fallback_succeeded", "Obsidian requestUrl 兜底成功", {
          endpoint,
          model: llmModel ? "<set>" : "",
          messageChars,
          payloadChars,
        });
        return fallbackData;
      } catch (fallbackError) {
        await logLlmRequestDiagnostic(plugin, "error", "llm.requesturl_fallback_failed", "Obsidian requestUrl 兜底失败", {
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
        await logLlmRequestDiagnostic(plugin, "error", "llm.http_failed", "LLM 返回非成功状态", {
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
          ? "LLM 调用已取消"
          : `LLM 调用超时：${Math.round(timeoutMs / 1000)} 秒内没有新数据`);
        if (cancelled) err.name = "AbortError";
        await logLlmRequestDiagnostic(
          plugin,
          cancelled ? "info" : "error",
          cancelled ? "llm.request_cancelled" : "llm.response_timeout",
          cancelled ? "LLM 请求已取消" : "LLM 响应读取超时",
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
      await logLlmRequestDiagnostic(plugin, "error", "llm.response_read_failed", "LLM 响应读取失败", {
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
    { role: "user", content: "Q&A Log connection test. Reply OK." },
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
  return /Failed to fetch|network|ECONNRESET|ETIMEDOUT|timeout|timed?\s*out|\b(429|500|502|503|504|529)\b|rate\s*limit|temporarily|service unavailable|overloaded|超时|响应流中断/i.test(msg);
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
  if (!base) throw new Error("服务地址未配置");
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

/** 从多种响应形态里取模型 id：OpenAI 形态 data/models，DashScope 原生形态 output.models/results。 */
function parseModelIds(payload) {
  const arr = (payload && (payload.data || payload.models))
    || (payload && payload.output && payload.output.models)
    || (payload && payload.results)
    || (Array.isArray(payload) ? payload : []);
  return (Array.isArray(arr) ? arr : [])
    .map(m => (typeof m === "string" ? m : (m && (m.id || m.name))))
    .map(x => String(x || "").trim())
    .filter(Boolean);
}

export async function fetchLlmModelList(endpoint, apiKey) {
  const base = normalizeLlmEndpoint(endpoint);
  if (!base) throw new Error("服务地址未配置");
  assertSafeServiceEndpoint(base, "http", "大模型服务地址");
  // 百炼的兼容地址与原生地址都要试：两者都真实存在（无钥均 401），
  // 不同账号/网关下可用的一个可能与预设的改写地址不同，先按改写地址、再按通用地址。
  const genericUrl = /\/chat\/completions$/i.test(base)
    ? base.replace(/\/chat\/completions$/i, "/models")
    : base.replace(/\/+$/, "") + "/models";
  const urls = [resolveLlmModelListEndpoint(endpoint)];
  if (!urls.includes(genericUrl)) urls.push(genericUrl);
  const headers = buildLlmHeaders(apiKey, base);
  delete headers["Content-Type"]; // GET 无 body
  const problems: string[] = [];
  for (const url of urls) {
    const res = await obsidian.requestUrl({ url, method: "GET", headers, throw: false });
    if (res.status < 200 || res.status >= 300) {
      problems.push(`${url} → HTTP ${res.status}：${String(res.text || "").slice(0, 200)}`);
      continue;
    }
    let data;
    try { data = res.json || JSON.parse(res.text || "{}"); } catch {
      problems.push(`${url} → 响应不是合法 JSON`);
      continue;
    }
    const ids = Array.from(new Set(parseModelIds(data))).sort((a, b) => a.localeCompare(b));
    if (ids.length) return ids;
    problems.push(`${url} → 未返回模型列表`);
  }
  throw new Error(problems.join("；") || "获取模型列表失败");
}

export function getLlmConfigIssue(settings) {
  const endpoint = normalizeLlmEndpoint(settings && settings.llmEndpoint);
  const model = String((settings && settings.llmModel) || "").trim();
  const apiKey = String((settings && settings.llmApiKey) || "").trim();
  if (!endpoint) return "大模型服务地址未配置";
  const endpointSecurityIssue = getServiceEndpointSecurityIssue(endpoint, "http", "大模型服务地址");
  if (endpointSecurityIssue) return endpointSecurityIssue;
  if (!model) return "大模型名称未配置";
  if (!apiKey && !canOmitServiceApiKey(endpoint)) return "大模型访问密钥未配置；只有本地、局域网或 Tailscale 等私有网络服务可以留空";
  return "";
}

export function isLlmConfigError(error) {
  const msg = String((error && error.message) || error || "");
  return /大模型(?:服务地址|名称|访问密钥)(?:未配置|不安全|格式无效|协议不受支持)|请先在 API 页配置大模型服务|LLM 配置/i.test(msg);
}

export function isLlmServiceBlockedError(error) {
  const msg = String((error && error.message) || error || "");
  return /暂无可用账号|no available account|账号不可用|账号池|余额不足|insufficient\s+quota|quota\s+exceeded|invalid[_\s-]*api[_\s-]*key|unauthorized|forbidden|access\s*denied|model[_\s-]*not[_\s-]*found|模型(?:不存在|不可用|无可用)|context[_\s-]*length|maximum context|too many tokens|上下文(?:过长|超限)|内容过长/i.test(msg);
}

export function isNonRetryableLlmHttpFailure(status, detail) {
  const code = Number(status) || 0;
  const msg = String(detail || "");
  if (isLlmServiceBlockedError(msg)) return true;
  return [400, 401, 403, 404].includes(code);
}

export function isLlmNonRetryableError(error) {
  if (error && error.nonRetryable) return true;
  return isLlmConfigError(error) || isLlmServiceBlockedError(error);
}

export function isLlmContextLimitError(error) {
  const status = Number(error && error.status) || 0;
  if (![400, 413].includes(status)) return false;
  const message = String((error && (error.statusDetail || error.message)) || error || "");
  return /context(?:\s|[_-])?(?:length|window|limit)|maximum\s+context|prompt\s+(?:is\s+)?too\s+long|input\s+(?:is\s+)?too\s+long|too\s+many\s+(?:input\s+)?tokens|上下文(?:过长|超限)|输入(?:过长|超限)/i.test(message);
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
        await logLlmRequestDiagnostic(plugin, "warn", "llm.output_parameter_fallback", "服务端不接受 max_tokens，已切换为 max_completion_tokens 重试", {
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
      await logLlmRequestDiagnostic(plugin, "warn", "llm.output_budget_fallback", "服务端拒绝当前输出预算，已按实际能力降档重试", {
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
  throw new Error("LLM 输出预算重试次数已用尽");
}

export function formatLlmConfigIssue(issue) {
  const text = String(issue || "").trim();
  if (!text) return "";
  if (/请到「设置/.test(text)) return text;
  return `${text}。请到「设置 → API → AI 整理服务」补齐后先测试连接。`;
}

export function formatLlmFailureIssue(issue) {
  const text = String(issue || "").trim();
  if (!text) return "";
  if (isLlmConfigError(text)) return formatLlmConfigIssue(text);
  if (isLlmServiceBlockedError(text)) {
    return `${text}。这是大模型服务端或账号池返回的问题，不是文本长度、ASR 或文本导入路径导致的；请切换模型/端点，或稍后手动重试。`;
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
      await logLlmRequestDiagnostic(plugin, "warn", "llm.empty_truncated_fast_retry", "模型耗尽输出预算但未返回正文，已关闭深度思考重试", {});
      first = await callLlmWithMeta(plugin, system, user, fastOptions);
      effectiveOptions = fastOptions;
      text = String(first.text || "");
      finishReason = first.finishReason;
      usage = addLlmUsage(usage, first.usage);
    } catch (error) {
      try {
        await logLlmRequestDiagnostic(plugin, "warn", "llm.empty_truncated_fast_retry_failed", "关闭深度思考后的空正文恢复请求失败", {
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
        await logLlmRequestDiagnostic(plugin, "warn", "llm.continuation_failed", "截断续写请求失败，已保留现有正文", {
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
        await logLlmRequestDiagnostic(plugin, "warn", "llm.continuation_empty", "截断续写仍未返回可见正文", {
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
      await logLlmRequestDiagnostic(plugin, "warn", "llm.merge_empty_output", "大模型请求完成但没有返回可见正文", Object.assign({
        finishReason: finishReason || "",
        continuations,
        continuationAttempts,
      }, diagCtx || {}));
    } catch { /* intentionally empty */ }
  }
  if (continuations > 0) {
    try {
      await logLlmRequestDiagnostic(plugin, "info", "llm.merge_continued", "输出被截断后自动续写拼接", Object.assign({
        continuations, truncatedAfter: truncated, outputChars: text.length,
      }, diagCtx || {}));
    } catch { /* intentionally empty */ }
  }
  if (truncated) {
    try {
      await logLlmRequestDiagnostic(plugin, "warn", "llm.merge_truncated", "最终纪要在多次续写后仍疑似被输出长度上限截断", Object.assign({
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
