export type RecentMetaTranslate = (key: string) => string;

export interface RecentMetaPart {
  kind: "text" | "duration";
  value: string;
}

export function formatRecentMetaParts(timeText: string, modeText: string, durationText: string): RecentMetaPart[] {
  const parts: RecentMetaPart[] = [];
  if (timeText) parts.push({ kind: "text", value: timeText });
  if (modeText) parts.push({ kind: "text", value: modeText });
  if (durationText) parts.push({ kind: "duration", value: durationText });
  return parts;
}

function applyRecentMetaTemplate(translate: RecentMetaTranslate, key: string, values: string[]): string {
  return values.reduce((text, value, index) => text.replace(`{${index}}`, value), translate(key));
}

export function formatRecentDurationText(ms: number, translate: RecentMetaTranslate): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return applyRecentMetaTemplate(translate, "{0}s", [String(totalSeconds)]);
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return applyRecentMetaTemplate(translate, "{0}m {1}s", [String(totalMinutes), String(totalSeconds % 60)]);
  return applyRecentMetaTemplate(translate, "{0}h {1}m", [String(Math.floor(totalMinutes / 60)), String(totalMinutes % 60).padStart(2, "0")]);
}

export interface RecentMetaTimeOptions {
  includeDate: boolean;
  hasTime: boolean;
  translate: RecentMetaTranslate;
}

function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDate(date: Date, includeYear: boolean): string {
  const monthDay = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return includeYear ? `${date.getFullYear()}-${monthDay}` : monthDay;
}

export function formatRecentMetaTime(timestamp: number, now: number, options: RecentMetaTimeOptions): string {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return "";
  const date = new Date(timestamp);
  const current = new Date(now);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(current.getTime())) return "";
  const clock = options.hasTime ? formatClock(date) : "";
  if (!options.includeDate) return clock || formatDate(date, false);

  const dayNumber = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const dayDelta = Math.round((dayNumber(current) - dayNumber(date)) / 86_400_000);
  if (dayDelta === 0) return applyRecentMetaTemplate(options.translate, "Today {0}", [clock]).trim();
  if (dayDelta === 1) return applyRecentMetaTemplate(options.translate, "Yesterday {0}", [clock]).trim();
  return `${formatDate(date, date.getFullYear() !== current.getFullYear())}${clock ? ` ${clock}` : ""}`;
}
