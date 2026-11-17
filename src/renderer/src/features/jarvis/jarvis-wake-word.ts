import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { samplesToWav } from "../../voice-recording";
import { voicePort } from "../settings/voice-port";
import { isJarvisMicBusyForWake, setJarvisMicAudio } from "./jarvis-audio-signal";
import { wakeWordEnabled } from "./jarvis-maestro-store";

export type WakeWordStatus = "off" | "listening" | "paused" | "checking" | "error";

const DIGITAL_SILENCE_DB = -90;
const NOISE_RISE_DB = 0.08;
const NOISE_MARGIN_DB = 6;
const PEAK_FALL_DB = 0.05;
const MIN_RANGE_DB = 12;
const SPEECH_LOUDNESS_THRESHOLD = 0.26;
const ONSET_MIN_MS = 160;
const END_SILENCE_MS = 520;
const MAX_UTTERANCE_MS = 3_200;
const PRE_ROLL_SECONDS = 0.45;
const RING_SECONDS = 4.5;
const COOLDOWN_MS = 900;

const WAKE_WORD_REGEX =
  /^(?:(?:ei|oi|ok|hey|ola|ol[aá]|fala|e\s*a[ií])\s+)?(?:j\.?\s*a\.?\s*r\.?\s*v\.?\s*i\.?\s*s|jarvis|jarves|djarvis|gervis)\b[\s,.:;!?-]*(.*)$/iu;

const [wakeWordStatus, setWakeWordStatus] = createSignal<WakeWordStatus>("off");
const [wakeWordError, setWakeWordError] = createSignal<string | null>(null);

export { wakeWordError, wakeWordStatus };

export function parseWakeWordTranscript(text: string): { matched: boolean; command: string } {
  const cleaned = text.trim();
  if (!cleaned) return { matched: false, command: "" };
  const direct = WAKE_WORD_REGEX.exec(cleaned);
  if (direct) {
    return { matched: true, command: (direct[1] ?? "").trim() };
  }
  const elsewhere = /\b(?:j\.?\s*a\.?\s*r\.?\s*v\.?\s*i\.?\s*s|jarvis|jarves|djarvis)\b[\s,.:;!?-]*(.*)$/iu.exec(
    cleaned,
  );
  if (elsewhere) {
    return { matched: true, command: (elsewhere[1] ?? "").trim() };
  }
  return { matched: false, command: "" };
}

/**
 * Starts the lightweight local Wake Word detector (WebAudio dB VAD + OpenBot local STT).
 * Automatically suspends its microphone stream whenever active dictation or voice conversation
 * claims the mic, and releases cleanly on unmount.
 */
export function startJarvisWakeWordEngine(options: { onWakeDetected: (commandText: string) => void }): () => void {
  let disposed = false;
  let running = false;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let processor: ScriptProcessorNode | undefined;
  let sourceNode: MediaStreamAudioSourceNode | undefined;
  let silentGain: GainNode | undefined;
  let checking = false;
  let lastTriggerAt = 0;

  function stopMic(): void {
    const wasRunning = running;
    running = false;
    if (wasRunning) {
      queueMicrotask(() => setJarvisMicAudio("wake", false));
    }
    if (processor) {
      processor.onaudioprocess = null;
      try {
        processor.disconnect();
      } catch {
        // Ignore disconnect errors on teardown.
      }
      processor = undefined;
    }
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {
        // Ignore disconnect errors on teardown.
      }
      sourceNode = undefined;
    }
    if (silentGain) {
      try {
        silentGain.disconnect();
      } catch {
        // Ignore disconnect errors on teardown.
      }
      silentGain = undefined;
    }
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = undefined;
    if (context) {
      void context.close().catch(() => {});
      context = undefined;
    }
  }

  async function evaluateBuffer(samples: Float32Array, sampleRate: number): Promise<void> {
    if (disposed || checking) return;
    if (Date.now() - lastTriggerAt < COOLDOWN_MS) return;
    const voice = voicePort()?.voice;
    if (!voice?.transcribe) return;

    checking = true;
    setWakeWordStatus("checking");
    try {
      const wav = samplesToWav(samples, sampleRate);
      const result = await voice.transcribe({ audio: wav });
      if (disposed) return;
      const parsed = parseWakeWordTranscript(result.text);
      if (parsed.matched) {
        lastTriggerAt = Date.now();
        options.onWakeDetected(parsed.command);
      }
    } catch (error) {
      if (!disposed) {
        setWakeWordError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      checking = false;
      if (!disposed && wakeWordEnabled()) {
        setWakeWordStatus(isJarvisMicBusyForWake() ? "paused" : running ? "listening" : "error");
      }
    }
  }

  async function startMic(): Promise<void> {
    if (disposed || running || !navigator.mediaDevices?.getUserMedia) return;
    setWakeWordError(null);
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (disposed || !wakeWordEnabled() || isJarvisMicBusyForWake()) {
        for (const track of mediaStream.getTracks()) track.stop();
        return;
      }

      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(mediaStream);
      const bufferSize = 2048;
      const proc = audioContext.createScriptProcessor(bufferSize, 1, 1);
      const zeroGain = audioContext.createGain();
      zeroGain.gain.value = 0;

      const rate = audioContext.sampleRate;
      const ringCapacity = Math.max(rate * RING_SECONDS, bufferSize * 8);
      const ring = new Float32Array(ringCapacity);
      let writeCursor = 0;
      let totalWritten = 0;

      let noiseDb = Number.POSITIVE_INFINITY;
      let peakDb = Number.NEGATIVE_INFINITY;
      let shownLevel = 0;

      let speechActive = false;
      let onsetMs = 0;
      let silenceMs = 0;
      let speechStartSample = 0;

      const sliceSince = (startSampleAbs: number, endSampleAbs: number): Float32Array => {
        const length = Math.min(ringCapacity, Math.max(0, endSampleAbs - startSampleAbs));
        const out = new Float32Array(length);
        let readPos = ((startSampleAbs % ringCapacity) + ringCapacity) % ringCapacity;
        for (let i = 0; i < length; i += 1) {
          out[i] = ring[readPos] ?? 0;
          readPos = (readPos + 1) % ringCapacity;
        }
        return out;
      };

      proc.onaudioprocess = (event) => {
        if (disposed || !running) return;
        const input = event.inputBuffer.getChannelData(0);
        const frameMs = (input.length / rate) * 1000;

        let sum = 0;
        for (let i = 0; i < input.length; i += 1) {
          const sample = input[i] ?? 0;
          sum += sample * sample;
          ring[writeCursor] = sample;
          writeCursor = (writeCursor + 1) % ringCapacity;
        }
        totalWritten += input.length;

        const db = 20 * Math.log10(Math.max(Math.sqrt(sum / input.length), 1e-5));
        if (db > DIGITAL_SILENCE_DB) {
          noiseDb = db < noiseDb ? db : Math.min(db, noiseDb + NOISE_RISE_DB);
          peakDb = Math.max(db, peakDb - PEAK_FALL_DB);
        }
        const range = Math.max(MIN_RANGE_DB, peakDb - noiseDb - NOISE_MARGIN_DB);
        const loudness = Math.min(1, Math.max(0, (db - noiseDb - NOISE_MARGIN_DB) / range));
        const level = loudness * loudness;
        shownLevel += (level - shownLevel) * (level > shownLevel ? 0.6 : 0.35);

        // Keep standby orb breathing gently without looking erratic while silent
        setJarvisMicAudio("wake", true, loudness >= SPEECH_LOUDNESS_THRESHOLD ? shownLevel : shownLevel * 0.35);

        if (checking) return;

        if (loudness >= SPEECH_LOUDNESS_THRESHOLD) {
          silenceMs = 0;
          if (!speechActive) {
            onsetMs += frameMs;
            if (onsetMs >= ONSET_MIN_MS) {
              speechActive = true;
              const preRollSamples = Math.floor(rate * PRE_ROLL_SECONDS);
              speechStartSample = Math.max(0, totalWritten - preRollSamples - input.length);
            }
          } else {
            const elapsedMs = ((totalWritten - speechStartSample) / rate) * 1000;
            if (elapsedMs >= MAX_UTTERANCE_MS) {
              speechActive = false;
              onsetMs = 0;
              const captured = sliceSince(speechStartSample, totalWritten);
              void evaluateBuffer(captured, rate);
            }
          }
        } else if (speechActive) {
          silenceMs += frameMs;
          if (silenceMs >= END_SILENCE_MS) {
            speechActive = false;
            onsetMs = 0;
            silenceMs = 0;
            const captured = sliceSince(speechStartSample, totalWritten);
            void evaluateBuffer(captured, rate);
          }
        } else {
          onsetMs = 0;
        }
      };

      source.connect(proc);
      proc.connect(zeroGain);
      zeroGain.connect(audioContext.destination);

      stream = mediaStream;
      context = audioContext;
      processor = proc;
      sourceNode = source;
      silentGain = zeroGain;
      running = true;
      setWakeWordStatus("listening");
    } catch (error) {
      stopMic();
      if (!disposed) {
        setWakeWordError(error instanceof Error ? error.message : String(error));
        setWakeWordStatus("error");
      }
    }
  }

  createEffect(
    () => ({ enabled: wakeWordEnabled(), busy: isJarvisMicBusyForWake() }),
    ({ enabled, busy }) => {
      if (!enabled) {
        stopMic();
        if (untrack(wakeWordError) !== null) setWakeWordError(null);
        if (untrack(wakeWordStatus) !== "off") setWakeWordStatus("off");
        return;
      }
      if (busy) {
        stopMic();
        if (untrack(wakeWordStatus) !== "paused") setWakeWordStatus("paused");
        return;
      }
      void startMic();
    },
  );

  onCleanup(() => {
    disposed = true;
    stopMic();
    if (untrack(wakeWordStatus) !== "off") {
      queueMicrotask(() => setWakeWordStatus("off"));
    }
  });

  return () => {
    disposed = true;
    stopMic();
    setWakeWordStatus("off");
  };
}
