import type { OrbBaseState } from "@openbot/ui/features/jarvis/JarvisOrb";
import { createMemo, createSignal, untrack } from "solid-js";
import { speechReading } from "../speech/speech-playback";

export type JarvisMicSource = "dictation" | "conversation" | "wake";

interface JarvisMicState {
  active: boolean;
  level: number;
  source: JarvisMicSource | null;
}

export interface JarvisOrbAudioState {
  mode: "idle" | "listening" | "speaking";
  level: number;
  source: JarvisMicSource | "tts" | null;
}

const [micState, setMicState] = createSignal<JarvisMicState>({
  active: false,
  level: 0,
  source: null,
});

function clampAudioLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function setJarvisMicAudio(source: JarvisMicSource, active: boolean, level = 0): void {
  const current = untrack(micState);
  if (!active) {
    if (current.source !== null && current.source !== source) return;
    if (!current.active && current.level === 0 && current.source === null) return;
    setMicState({ active: false, level: 0, source: null });
    return;
  }

  const nextLevel = clampAudioLevel(level);
  if (current.active && current.source === source && Math.abs(current.level - nextLevel) < 0.005) {
    return;
  }
  setMicState({
    active: true,
    level: nextLevel,
    source,
  });
}

export function useJarvisOrbAudio(): () => JarvisOrbAudioState {
  return createMemo<JarvisOrbAudioState>(() => {
    const mic = micState();
    const reading = speechReading();

    // Priority 1: Active dictation or voice conversation overrides TTS playback visually
    if (mic.active && (mic.source === "dictation" || mic.source === "conversation")) {
      return {
        mode: "listening",
        level: mic.level,
        source: mic.source,
      };
    }

    // Priority 2: Agent TTS playback
    if (reading && !reading.paused) {
      const latestLevel = reading.levels[reading.levels.length - 1] ?? 0;
      return {
        mode: "speaking",
        level: clampAudioLevel(latestLevel),
        source: "tts",
      };
    }

    // Priority 3: Continuous Wake Word standby VAD
    if (mic.active && mic.source === "wake") {
      return {
        mode: "listening",
        level: mic.level,
        source: "wake",
      };
    }

    return {
      mode: "idle",
      level: 0,
      source: null,
    };
  });
}

export { micState };

export function isJarvisMicBusyForWake(): boolean {
  const mic = micState();
  return mic.active && (mic.source === "dictation" || mic.source === "conversation");
}

export function resolveOrbStatusWithAudio(
  baseStatus: OrbBaseState,
  audioMode: JarvisOrbAudioState["mode"],
): OrbBaseState {
  if (audioMode === "listening") return "listening";
  if (audioMode === "speaking") return "speaking";
  return baseStatus;
}
