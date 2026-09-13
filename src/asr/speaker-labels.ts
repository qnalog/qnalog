// 说话人标签摄取（diarization）。
// WhisperX / whisper-diarization 这类带说话人分离的本地服务，会用两种方式给出说话人：
//   ① 结构化 segments[].speaker（如 "SPEAKER_00"）——OpenAI verbose_json / WhisperX 风格；
//   ② 内联在 text 里的标签（如 "[SPEAKER_00] 你好…"）。
// 这里把两种都归一成统一的 `[说话人N]` 前缀，落进逐字稿；后续 AI 整理会像处理 `[麦克风]`/`[电脑音频]`
// 来源标记一样按发言人区分。普通转写服务（只返回 text、无 speaker）行为完全不变。
// 纯函数、无外部依赖，可独立单测。
//
// 提示（跨段一致性）：diarization 的说话人编号靠整段音频做声纹聚类才稳定。QnALog 边录边按段上传时，
// 每段是独立的一次转写调用，跨段的 "SPEAKER_00" 不保证是同一人——所以编号只在「单次转写调用」内一致。
// 想要全程一致的说话人编号，应走「导入整段音频」让服务一次性转写整段。

// 把原始说话人标识归一为友好标签：通用 ID（SPEAKER_00 / spk1 / 0…）按出现顺序编号为「说话人N」；
// 已命名的说话人（如 "Alice"）原样保留。map 在一次调用内保持映射稳定。
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- ASR diarization payloads are provider-specific JSON; these helpers normalize untyped response objects defensively. */
export function friendlySpeakerLabel(raw, map) {
  const key = String(raw == null ? "" : raw).trim();
  if (!key) return "";
  if (map.has(key)) return map.get(key);
  const generic = /^(?:speaker|spk|s)[\s_-]*\d+$/i.test(key) || /^\d+$/.test(key) || /^[A-Z]$/.test(key);
  const friendly = generic ? `说话人${map.size + 1}` : key;
  map.set(key, friendly);
  return friendly;
}

// 由结构化 segments（每条带 text + speaker）拼出带 `[说话人N]` 前缀的文本：
// 连续同一说话人的段落合并为一轮，轮与轮之间换行。
export function composeSpeakerLabeledText(segments) {
  if (!Array.isArray(segments)) return "";
  const map = new Map();
  const parts = [];
  let curSpk = null;
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const t = buf.join(" ").replace(/\s+/g, " ").trim();
    if (t) parts.push(curSpk ? `[${curSpk}] ${t}` : t);
    buf = [];
  };
  for (const s of segments) {
    if (!s) continue;
    const txt = String(s.text == null ? "" : s.text).trim();
    if (!txt) continue;
    const spk = friendlySpeakerLabel(s.speaker, map);
    if (spk !== curSpk) { flush(); curSpk = spk; }
    buf.push(txt);
  }
  flush();
  return parts.join("\n");
}

// 把内联在纯文本里的说话人标签（[SPEAKER_00] / SPEAKER_01: / Speaker 0 / spk2 …）归一成 `[说话人N]`。
export function normalizeInlineSpeakerTags(text) {
  const s0 = String(text == null ? "" : text);
  if (!/(?:speaker|spk)[\s_]*\d+/i.test(s0)) return s0;
  const map = new Map();
  return s0.replace(/\[?\s*(?:speaker|spk)[\s_]*(\d+)\s*\]?\s*[:：]?\s*/gi, (_m, num) => {
    const key = `s${num}`;
    if (!map.has(key)) map.set(key, `说话人${map.size + 1}`);
    return `[${map.get(key)}] `;
  });
}

// 从一次转写响应里取最终文本：优先用结构化 speaker 信息；否则回退到 text/transcript/result 并归一内联标签。
export function extractTranscriptText(data) {
  const d = data && typeof data === "object" ? data : {};
  const segs = Array.isArray(d.segments) ? d.segments : null;
  const hasSpeaker = !!(segs && segs.some(s => s && s.speaker != null && String(s.speaker).trim() !== ""));
  if (hasSpeaker) {
    const composed = composeSpeakerLabeledText(segs).trim();
    if (composed) return composed;
  }
  const plain = String(d.text != null ? d.text : (d.transcript != null ? d.transcript : (d.result != null ? d.result : "")));
  return normalizeInlineSpeakerTags(plain).trim();
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of dynamic-typing region */
