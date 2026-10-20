// 整场录音是否基本无声的判定。
//
// 录音器每 160 毫秒统计一次电平：达到 `recorder-service.ts` 中的有声门限记为有声，否则记为无声。
// 收尾时把两个计数交给本函数。判据只用电平计数，不看转写文本，因此转写服务不可用、
// 或服务读不出音乐、歌声、拍手与未支持语言时，仍能区分「有声音」与「真的没声音」。
//
// 两个常量的理由：
// - 最少计数 5 次（约 0.8 秒）：更短的会话没有可靠的统计，按「有声」处理，保留音频。
//   宁可保留一段无声录音，也不删除可能有声的录音。
// - 有声占比低于 2%：与「整场几乎没检测到声音」提示的判据相同。
//   按 160 毫秒一次计算，50 次（约 8 秒）以内任何一次有声计数都会使整场被视为有声。

export const SESSION_SILENCE_MIN_TICKS = 5;

export const SESSION_SILENCE_MAX_VOICED_SHARE = 0.02;

/**
 * 有声与无声计数是否表明整场基本无声。
 * 计数不足（含 0 与 0）或有采样帧未知时返回 false：这些状态不能证明整场无声。
 */
export function isEssentiallySilentSession(voiced: number, silent: number, evidenceUnknown = false): boolean {
  if (evidenceUnknown) return false;
  const voicedTicks = Number.isFinite(Number(voiced)) ? Math.max(0, Math.floor(Number(voiced))) : 0;
  const silentTicks = Number.isFinite(Number(silent)) ? Math.max(0, Math.floor(Number(silent))) : 0;
  const total = voicedTicks + silentTicks;
  if (total < SESSION_SILENCE_MIN_TICKS) return false;
  return voicedTicks / total < SESSION_SILENCE_MAX_VOICED_SHARE;
}
