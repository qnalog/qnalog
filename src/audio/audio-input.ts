import { VIRTUAL_CABLE_PATTERNS } from "../shared/catalog-import";
import { t } from "../shared/i18n";
import type { AudioInputMode } from "../shared/types";

const SUPPORTED_AUDIO_INPUT_MODES = new Set<AudioInputMode>(["mic", "mix-virtual", "virtualCable"]);

export interface AudioDeviceLike {
  kind?: string;
  deviceId?: string;
  label?: string;
}

export type AudioDeviceAvailability =
  | { state: "none"; count: 0 }
  | { state: "named" | "unnamed"; count: number };

export function normalizeAudioInputMode(mode: unknown): AudioInputMode {
  if (mode === "mix") return "mix-virtual";
  if (mode === "system") return "virtualCable";
  return typeof mode === "string" && SUPPORTED_AUDIO_INPUT_MODES.has(mode as AudioInputMode)
    ? mode as AudioInputMode
    : "mic";
}

export function audioInputModeLabel(mode: unknown): string {
  const labels: Record<AudioInputMode, string> = {
    mic: t("Microphone only"),
    "mix-virtual": t("Microphone + computer audio"),
    virtualCable: t("Computer audio only"),
  };
  return labels[normalizeAudioInputMode(mode)];
}

export function isVirtualCableLabel(label: unknown): boolean {
  if (typeof label !== "string" || !label) return false;
  return VIRTUAL_CABLE_PATTERNS.some((pattern) => pattern.test(label));
}

export function classifyAudioInputDevices(
  devices: AudioDeviceLike[] | null | undefined,
  selectedId = "",
): { selectedInput: AudioDeviceLike | null; dongles: AudioDeviceLike[] } {
  const inputs = (devices || []).filter((device) => !!device && device.kind === "audioinput");
  const selected = String(selectedId || "");
  return {
    selectedInput: selected ? inputs.find((device) => device.deviceId === selected) || null : null,
    dongles: inputs.filter((device) => !isSystemDefaultDeviceId(device.deviceId)),
  };
}

export function pickComputerAudioDevices(
  devices: AudioDeviceLike[] | null | undefined,
): { listed: AudioDeviceLike[]; virtualCables: AudioDeviceLike[] } {
  const { dongles } = classifyAudioInputDevices(devices);
  const virtualCables = dongles.filter((device) => isVirtualCableLabel(device.label));
  return { listed: virtualCables.length ? virtualCables : dongles, virtualCables };
}

export function describeAudioDeviceAvailability(
  devices: AudioDeviceLike[] | null | undefined,
): AudioDeviceAvailability {
  const inputs = (devices || []).filter((device) => !!device && device.kind === "audioinput");
  if (!inputs.length) return { state: "none", count: 0 };
  const named = inputs.some((device) => !!device.label);
  return { state: named ? "named" : "unnamed", count: inputs.length };
}

function isSystemDefaultDeviceId(deviceId?: string): boolean {
  const id = String(deviceId || "");
  return id === "default" || id === "";
}
