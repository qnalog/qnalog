const stringifyFailureValue = String as (value: unknown) => string;

function readFailureField(
  error: unknown,
  field: "message" | "status" | "statusDetail" | "nonRetryable",
): unknown {
  if (!error) return error;
  if (typeof error === "object" || typeof error === "function") {
    return Reflect.get(error, field);
  }
  return undefined;
}

function failureText(error: unknown, detail = false): string {
  const value: unknown = (
    detail
      ? readFailureField(error, "statusDetail") || readFailureField(error, "message")
      : readFailureField(error, "message")
  ) || error || "";
  return stringifyFailureValue(value);
}

export function isLlmConfigError(error: unknown): boolean {
  const msg = failureText(error);
  return /大模型(?:服务地址|名称|访问密钥)(?:未配置|不安全|格式无效|协议不受支持)|LLM service address (?:is not configured|is insecure|is invalid|uses an unsupported protocol)|LLM (?:model name|api key) is not configured|请先在 API 页配置大模型服务|Please configure an LLM service on the API page first|LLM 配置/i.test(msg);
}

export function isLlmServiceBlockedError(error: unknown): boolean {
  const msg = failureText(error);
  return /暂无可用账号|no available account|账号不可用|账号池|余额不足|insufficient\s+quota|quota\s+exceeded|invalid[_\s-]*api[_\s-]*key|unauthorized|forbidden|access\s*denied|model[_\s-]*not[_\s-]*found|模型(?:不存在|不可用|无可用)|LLM unavailable|context[_\s-]*length|maximum context|too many tokens|上下文(?:过长|超限)|内容过长/i.test(msg);
}

export function isNonRetryableLlmHttpFailure(status: unknown, detail: unknown): boolean {
  const code = Number(status) || 0;
  const value: unknown = detail || "";
  const msg = stringifyFailureValue(value);
  if (isLlmServiceBlockedError(msg)) return true;
  return code === 400 || code === 401 || code === 403 || code === 404;
}

export function isLlmNonRetryableError(error: unknown): boolean {
  if (readFailureField(error, "nonRetryable")) return true;
  return isLlmConfigError(error) || isLlmServiceBlockedError(error);
}

export function isLlmContextLimitError(error: unknown): boolean {
  const status = Number(readFailureField(error, "status")) || 0;
  if (status !== 400 && status !== 413) return false;
  const message = failureText(error, true);
  return /context(?:\s|[_-])?(?:length|window|limit)|maximum\s+context|prompt\s+(?:is\s+)?too\s+long|input\s+(?:is\s+)?too\s+long|too\s+many\s+(?:input\s+)?tokens|上下文(?:过长|超限)|输入(?:过长|超限)/i.test(message);
}
