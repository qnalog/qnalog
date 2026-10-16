/**
 * 计算音频片段的均方根（RMS）振幅，取值范围 0 到 1（满量程为 1）。
 *
 * 多声道时对所有声道的所有采样取平方平均，因此与声道数无关：左右声道各为同一静音时结果不变。
 * 时间范围按采样率换算为采样帧区间 [startFrame, endFrame)，超出音频末尾的部分被截去。
 *
 * 返回值：片段内全部为零时为 0；区间内没有采样帧（或没有声道）时为 NaN，调用方据此视为「无法判定」。
 */
export function computeAudioRms(
  channels: ReadonlyArray<ArrayLike<number>>,
  sampleRate: number,
  startMs: number,
  endMs: number,
): number {
  if (channels.length === 0 || !(sampleRate > 0)) return Number.NaN;
  const frameCount = Math.min(...channels.map((channel) => channel.length));
  const startFrame = Math.max(0, Math.floor((Number(startMs) || 0) / 1000 * sampleRate));
  const endFrame = Math.min(frameCount, Math.ceil((Number(endMs) || 0) / 1000 * sampleRate));
  if (endFrame <= startFrame) return Number.NaN;
  let sumSquares = 0;
  for (const channel of channels) {
    for (let i = startFrame; i < endFrame; i++) {
      const sample = channel[i];
      sumSquares += sample * sample;
    }
  }
  return Math.sqrt(sumSquares / ((endFrame - startFrame) * channels.length));
}
