export type HudQuality = "ALTA" | "MEDIA" | "ECONOMIA";
export const HUD_QUALITY_KEY = "jarvis.hud.quality";
export const HUD_QUALITY = {
  ALTA: { fps: 60, blur: true, particleScale: 1 },
  MEDIA: { fps: 60, blur: true, particleScale: 0.5 },
  ECONOMIA: { fps: 30, blur: false, particleScale: 0.5 },
} as const;

export interface HudAudioFrame {
  time: Uint8Array<ArrayBuffer>;
  frequency: Uint8Array<ArrayBuffer>;
}

export interface HudFrame {
  time: number;
  delta: number;
  quality: HudQuality;
  audio: HudAudioFrame | null;
}

type Renderer = (frame: HudFrame) => void;

export class HudAnimationLoop {
  private renderers = new Map<Renderer, { priority: number; visible: boolean }>();
  private raf: number | null = null;
  private last: number | null = null;
  private sampleStart: number | null = null;
  private sampleFrames = 0;
  private quality: HudQuality | null = null;
  private listeners = new Set<() => void>();
  private analyser: AnalyserNode | null = null;
  private audioSource: (() => AnalyserNode | null) | null = null;
  private audio: HudAudioFrame | null = null;
  private listening = false;

  setAudioSource(source: (() => AnalyserNode | null) | null): void {
    this.audioSource = source;
    if (!source) this.setAnalyser(null);
  }

  getQuality = (): HudQuality => {
    if (this.quality) return this.quality;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    this.quality = reduced ? "ECONOMIA" : "ALTA";
    try {
      const saved = localStorage.getItem(HUD_QUALITY_KEY);
      if (!reduced && (saved === "ALTA" || saved === "MEDIA" || saved === "ECONOMIA")) this.quality = saved;
    } catch {
      /* Storage may be disabled by the shell. */
    }
    return this.quality;
  };

  setQuality = (quality: HudQuality, persist = true): void => {
    if (!(quality in HUD_QUALITY)) return;
    this.quality = quality;
    this.sampleStart = null;
    this.sampleFrames = 0;
    if (persist) {
      try {
        localStorage.setItem(HUD_QUALITY_KEY, quality);
      } catch {
        /* Keep the session preference. */
      }
    }
    if (typeof document !== "undefined") document.documentElement.dataset.hudQuality = quality;
    for (const listener of this.listeners) listener();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setAnalyser(analyser: AnalyserNode | null): void {
    if (analyser === this.analyser && (!analyser || this.audio?.time.length === analyser.fftSize)) return;
    this.analyser = analyser;
    this.audio = analyser
      ? {
          time: new Uint8Array(analyser.fftSize),
          frequency: new Uint8Array(analyser.frequencyBinCount),
        }
      : null;
  }

  register(fn: Renderer, { priority = 0, element }: { priority?: number; element?: Element } = {}): () => void {
    const entry = { priority, visible: true };
    this.renderers.set(fn, entry);
    let observer: IntersectionObserver | undefined;
    if (element && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(([event]) => {
        if (!event) return;
        entry.visible = event.isIntersecting;
        this.sync();
      });
      observer.observe(element);
    }
    if (!this.listening && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.visibility);
      this.listening = true;
      document.documentElement.dataset.hudQuality = this.getQuality();
    }
    this.sync();
    return () => {
      observer?.disconnect();
      this.renderers.delete(fn);
      this.sync();
      if (!this.renderers.size && this.listening) {
        document.removeEventListener("visibilitychange", this.visibility);
        this.listening = false;
      }
    };
  }

  private visibility = (): void => {
    this.sync();
  };

  private sync(): void {
    const active =
      typeof document !== "undefined" && !document.hidden && [...this.renderers.values()].some((r) => r.visible);
    if (!active) {
      if (this.raf !== null) cancelAnimationFrame(this.raf);
      this.raf = null;
      this.last = this.sampleStart = null;
      this.sampleFrames = 0;
    } else if (this.raf === null) {
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  private tick = (time: number): void => {
    const quality = this.getQuality();
    if (quality !== "ECONOMIA" || this.last === null || time - this.last >= 1000 / 30 - 0.5) {
      const delta = this.last === null ? 0 : time - this.last;
      this.last = time;
      if (quality === "ALTA") {
        if (this.sampleStart === null) {
          this.sampleStart = time;
          this.sampleFrames = 0;
        } else {
          this.sampleFrames += 1;
        }
        const elapsed = time - this.sampleStart;
        if (elapsed >= 3000) {
          const fps = (this.sampleFrames * 1000) / elapsed;
          if (fps < 50) {
            this.setQuality("MEDIA", false);
          }
          this.sampleStart = time;
          this.sampleFrames = 0;
        }
      }
      if (this.audioSource) this.setAnalyser(this.audioSource());
      if (this.analyser && this.audio) {
        this.analyser.getByteTimeDomainData(this.audio.time);
        this.analyser.getByteFrequencyData(this.audio.frequency);
      }
      const frame: HudFrame = { time, delta, quality: this.getQuality(), audio: this.audio };
      const sorted = [...this.renderers.entries()].sort((a, b) => b[1].priority - a[1].priority);
      for (const [fn, entry] of sorted) {
        if (entry.visible && this.renderers.has(fn)) {
          try {
            fn(frame);
          } catch {
            /* Keep other renderers alive on single-frame failure. */
          }
        }
      }
    }
    this.raf = null;
    this.sync();
  };
}

export const hudAnimationLoop = new HudAnimationLoop();

export function observeHudCanvas(
  canvas: HTMLCanvasElement,
  target: Element = canvas,
  square = false,
): { getSize: () => { width: number; height: number; dpr: number }; disconnect: () => void } {
  let size = { width: 1, height: 1, dpr: 1 };
  const resize = () => {
    const rect = target.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = square ? Math.min(rect.width, rect.height) || 160 : Math.max(1, rect.width);
    const height = square ? width : Math.max(1, rect.height);
    size = { width, height, dpr };
    const w = Math.max(1, Math.floor(width * dpr));
    const h = Math.max(1, Math.floor(height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  };
  resize();
  const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  observer?.observe(target);
  window.addEventListener("resize", resize);
  return {
    getSize: () => size,
    disconnect: () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    },
  };
}
