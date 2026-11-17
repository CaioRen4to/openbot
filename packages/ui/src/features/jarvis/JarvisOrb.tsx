import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { useText } from "../../text";
import { HUD_QUALITY, type HudFrame, type HudQuality, hudAnimationLoop, observeHudCanvas } from "./hud-animation-loop";

export type OrbBaseState = "idle" | "listening" | "thinking" | "speaking" | "error";
export type OrbVisualState = OrbBaseState | "degraded";

export const ORB_STATE_LABEL: Record<OrbVisualState, string> = {
  idle: "EM ESPERA",
  listening: "OUVINDO",
  thinking: "PROCESSANDO",
  speaking: "FALANDO",
  error: "ERRO",
  degraded: "ATENÇÃO",
};

export function mapOrbState(
  status: string,
  degraded: boolean,
): { base: OrbBaseState; degraded: boolean; label: string } {
  const base: OrbBaseState =
    status === "listening" || status === "thinking" || status === "speaking" || status === "error" ? status : "idle";
  const overlay = degraded && base !== "error";
  return { base, degraded: overlay, label: ORB_STATE_LABEL[base === "idle" && overlay ? "degraded" : base] };
}

export interface JarvisOrbSatellite {
  id: string;
  name?: string | undefined;
  color?: string | undefined;
}

export interface JarvisOrbProps {
  status: OrbBaseState | string;
  audioLevel?: number | undefined;
  degraded?: boolean | undefined;
  runningAgents?: readonly JarvisOrbSatellite[] | undefined;
  handoffPulse?: boolean | undefined;
  qualityTier?: HudQuality | undefined;
  class?: string | undefined;
}

const TAU = Math.PI * 2;
const GRAD = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1,
  -1,
]);
const PERM = new Uint8Array(512);
let seed = 17;
for (let i = 0; i < 256; i++) PERM[i] = i;
for (let i = 255; i > 0; i--) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const j = seed % (i + 1);
  const value = PERM[i] ?? 0;
  PERM[i] = PERM[j] ?? 0;
  PERM[j] = value;
}
for (let i = 0; i < 256; i++) PERM[i + 256] = PERM[i] ?? 0;

function simplexCorner(x: number, y: number, z: number, index: number): number {
  const t = 0.6 - x * x - y * y - z * z;
  if (t <= 0) return 0;
  const g = (index % 12) * 3;
  return t * t * t * t * ((GRAD[g] ?? 0) * x + (GRAD[g + 1] ?? 0) * y + (GRAD[g + 2] ?? 0) * z);
}

// Inline 3D Simplex; sampling a circle in XY makes every filament close seamlessly.
function simplex3(x: number, y: number, z: number): number {
  const skew = (x + y + z) / 3;
  const i = Math.floor(x + skew);
  const j = Math.floor(y + skew);
  const k = Math.floor(z + skew);
  const unskew = (i + j + k) / 6;
  const x0 = x - i + unskew;
  const y0 = y - j + unskew;
  const z0 = z - k + unskew;
  let i1 = 0;
  let j1 = 0;
  let k1 = 0;
  let i2 = 0;
  let j2 = 0;
  let k2 = 0;
  if (x0 >= y0) {
    if (y0 >= z0) {
      i1 = 1;
      j1 = 0;
      k1 = 0;
      i2 = 1;
      j2 = 1;
      k2 = 0;
    } else if (x0 >= z0) {
      i1 = 1;
      j1 = 0;
      k1 = 0;
      i2 = 1;
      j2 = 0;
      k2 = 1;
    } else {
      i1 = 0;
      j1 = 0;
      k1 = 1;
      i2 = 1;
      j2 = 0;
      k2 = 1;
    }
  } else if (y0 < z0) {
    i1 = 0;
    j1 = 0;
    k1 = 1;
    i2 = 0;
    j2 = 1;
    k2 = 1;
  } else if (x0 < z0) {
    i1 = 0;
    j1 = 1;
    k1 = 0;
    i2 = 0;
    j2 = 1;
    k2 = 1;
  } else {
    i1 = 0;
    j1 = 1;
    k1 = 0;
    i2 = 1;
    j2 = 1;
    k2 = 0;
  }
  const ii = i & 255;
  const jj = j & 255;
  const kk = k & 255;
  const p = (idx: number) => PERM[idx] ?? 0;
  return (
    32 *
    (simplexCorner(x0, y0, z0, p(ii + p(jj + p(kk)))) +
      simplexCorner(x0 - i1 + 1 / 6, y0 - j1 + 1 / 6, z0 - k1 + 1 / 6, p(ii + i1 + p(jj + j1 + p(kk + k1)))) +
      simplexCorner(x0 - i2 + 1 / 3, y0 - j2 + 1 / 3, z0 - k2 + 1 / 3, p(ii + i2 + p(jj + j2 + p(kk + k2)))) +
      simplexCorner(x0 - 0.5, y0 - 0.5, z0 - 0.5, p(ii + 1 + p(jj + 1 + p(kk + 1)))))
  );
}

const SATELLITE_TOKENS = ["var(--hud-cyan)", "var(--hud-green)", "var(--hud-amber)", "var(--hud-cyan-hot)"] as const;

export function JarvisOrb(props: JarvisOrbProps) {
  const { t } = useText();
  let containerRef: HTMLDivElement | undefined;
  let canvasRef: HTMLCanvasElement | undefined;
  const [errorExpired, setErrorExpired] = createSignal(false);

  const visual = createMemo(() =>
    mapOrbState(props.status === "error" && errorExpired() ? "idle" : props.status, Boolean(props.degraded)),
  );
  const orbStatusText = createMemo(() => {
    const current = visual();
    const key = current.base === "idle" && current.degraded ? "attention" : current.base;
    return t(`island.jarvis.status.${key}`);
  });

  const satellites = createMemo(() =>
    (props.runningAgents ?? []).slice(0, 8).map((sat, index, list) => {
      const angle = (index * TAU) / list.length - Math.PI / 2;
      return {
        ...sat,
        color: sat.color ?? SATELLITE_TOKENS[index % SATELLITE_TOKENS.length] ?? "var(--hud-cyan)",
        x: Math.cos(angle) * 1.04,
        y: Math.sin(angle) * 1.04,
      };
    }),
  );

  const pointer = { x: 0, y: 0 };

  function trackPointer(event: PointerEvent & { currentTarget: HTMLDivElement }): void {
    if (event.pointerType === "touch") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    const y = ((event.clientY - bounds.top) / bounds.height) * 2 - 1;
    const length = Math.max(1, Math.hypot(x, y));
    pointer.x = x / length;
    pointer.y = y / length;
  }

  function resetPointer(): void {
    pointer.x = 0;
    pointer.y = 0;
  }

  createEffect(
    () => props.status,
    (status) => {
      setErrorExpired(false);
      if (status !== "error") return;
      const timer = window.setTimeout(() => setErrorExpired(true), 300);
      return () => window.clearTimeout(timer);
    },
  );

  onSettled(() => {
    const canvas = canvasRef;
    const container = containerRef;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const sizing = observeHudCanvas(canvas, container, true);
    const styles = getComputedStyle(container);
    const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;

    const colors = [
      token("--hud-cyan", token("--openbot-accent", "cyan")),
      token("--hud-cyan-hot", token("--openbot-accent-hover", "cyan")),
      token("--hud-blue", token("--openbot-accent", "blue")),
      token("--hud-white", token("--openbot-text-primary", "white")),
      token("--hud-green", token("--openbot-success", "green")),
      token("--hud-amber", token("--openbot-warning", "orange")),
      token("--hud-red", token("--openbot-danger", "red")),
      token("--hud-gray", token("--openbot-text-muted", "gray")),
    ] as const;

    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const probeCtx = probe.getContext("2d", { willReadFrequently: true });
    const rgb = colors.map((color) => {
      if (!probeCtx) return new Uint8ClampedArray([0, 210, 255, 255]);
      probeCtx.clearRect(0, 0, 1, 1);
      probeCtx.fillStyle = color;
      probeCtx.fillRect(0, 0, 1, 1);
      return probeCtx.getImageData(0, 0, 1, 1).data;
    });
    const c0 = rgb[0] ?? new Uint8ClampedArray([0, 210, 255, 255]);
    const c4 = rgb[4] ?? new Uint8ClampedArray([0, 255, 170, 255]);
    const voiceColors = Array.from({ length: 61 }, (_, n) => {
      const t = n / 60;
      const r = Math.round((c0[0] ?? 0) + ((c4[0] ?? 0) - (c0[0] ?? 0)) * t);
      const g = Math.round((c0[1] ?? 0) + ((c4[1] ?? 0) - (c0[1] ?? 0)) * t);
      const b = Math.round((c0[2] ?? 0) + ((c4[2] ?? 0) - (c0[2] ?? 0)) * t);
      return `rgb(${r},${g},${b})`;
    });

    const shell = ctx.createRadialGradient(-0.22, -0.3, 0.03, 0, 0, 0.77);
    shell.addColorStop(0, token("--jarvis-orb-shell-0", colors[0]));
    shell.addColorStop(0.52, token("--jarvis-orb-shell-1", colors[2]));
    shell.addColorStop(0.88, token("--jarvis-orb-shell-2", colors[2]));
    shell.addColorStop(1, token("--jarvis-orb-shell-3", colors[2]));

    const halo = ctx.createRadialGradient(0, 0, 0.63, 0, 0, 1.1);
    halo.addColorStop(0, "transparent");
    halo.addColorStop(0.26, token("--jarvis-orb-halo-1", colors[0]));
    halo.addColorStop(0.62, token("--jarvis-orb-halo-2", colors[2]));
    halo.addColorStop(1, "transparent");

    const light = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    light.addColorStop(0, colors[3]);
    light.addColorStop(0.18, token("--jarvis-orb-light-1", colors[1]));
    light.addColorStop(0.53, token("--jarvis-orb-light-2", colors[2]));
    light.addColorStop(1, token("--jarvis-orb-light-3", "transparent"));

    const rim = ctx.createLinearGradient(-0.72, -0.72, 0.7, 0.66);
    rim.addColorStop(0, token("--jarvis-orb-rim-0", colors[3]));
    rim.addColorStop(0.34, colors[0]);
    rim.addColorStop(0.7, colors[2]);
    rim.addColorStop(1, token("--jarvis-orb-rim-3", colors[2]));

    const thinkingColor = token("--jarvis-orb-thinking", colors[1]);

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const anchors = new Float32Array(45 * 3);
    const points = new Float32Array(45 * 3);
    const heads = new Int16Array(64);
    const next = new Int16Array(45);
    const edgeA = new Int16Array(990);
    const edgeB = new Int16Array(990);
    const edgeBand = new Uint8Array(990);
    const rippleTimes = new Float64Array(4).fill(-10000);
    const circle = new Float32Array(65 * 2);
    for (let n = 0; n <= 64; n++) {
      circle[n * 2] = Math.cos((n / 64) * TAU);
      circle[n * 2 + 1] = Math.sin((n / 64) * TAU);
    }
    for (let n = 0; n < 45; n++) {
      const z = 1 - (2 * (n + 0.5)) / 45;
      const r = Math.cbrt((((n * 17) % 45) + 1) / 45) * 0.65;
      const xy = Math.sqrt(1 - z * z) * r;
      anchors[n * 3] = Math.cos(n * 2.399963) * xy;
      anchors[n * 3 + 1] = Math.sin(n * 2.399963) * xy;
      anchors[n * 3 + 2] = z * r;
    }

    let listening = 0;
    let thinking = 0;
    let speaking = 0;
    let overlay = 0;
    let energy = 0;
    let pointerX = 0;
    let pointerY = 0;
    let clock = 0;
    let gyroClock = 0;
    let previousEnergy = 0;
    let lastPeak = -10000;
    let rippleIndex = 0;
    let lastState = "";
    let errorStart = -10000;
    let lastWidth = -1;
    let lastDpr = 0;
    let lastQuality = "";
    let lastReduced = false;
    let lastOverlay = false;
    let lastSatelliteKey = "";
    let satelliteColors: string[] = [];

    const render = ({ time, delta, quality, audio }: HudFrame) => {
      const state = visual();
      const sats = satellites();
      const satKey = sats.map((s) => `${s.id}:${s.color}`).join("|");
      const reduced = mq.matches;
      const { width: size, dpr } = sizing.getSize();
      if (
        reduced &&
        lastReduced &&
        lastState === state.base &&
        lastOverlay === state.degraded &&
        lastWidth === size &&
        lastDpr === dpr &&
        lastQuality === quality &&
        lastSatelliteKey === satKey
      ) {
        return;
      }
      if (lastSatelliteKey !== satKey) {
        satelliteColors = sats.map((sat) =>
          sat.color.replace(/var\((--[\w-]+)\)/g, (_, tok: string) => styles.getPropertyValue(tok).trim() || colors[0]),
        );
        lastSatelliteKey = satKey;
      }
      if (state.base === "error" && lastState !== "error") errorStart = time;
      lastState = state.base;
      lastOverlay = state.degraded;
      lastWidth = size;
      lastDpr = dpr;
      lastQuality = quality;
      lastReduced = reduced;

      const dt = Math.min(delta || 16, 50) / 1000;
      const mix = reduced ? 1 : 1 - Math.exp(-dt / 0.2);
      listening += ((state.base === "listening" ? 1 : 0) - listening) * mix;
      thinking += ((state.base === "thinking" ? 1 : 0) - thinking) * mix;
      speaking += ((state.base === "speaking" ? 1 : 0) - speaking) * mix;
      overlay += ((state.degraded ? 1 : 0) - overlay) * mix;

      let rms = 0;
      if (!reduced && audio?.time.length) {
        for (let n = 0; n < audio.time.length; n++) {
          const sample = ((audio.time[n] ?? 128) - 128) / 128;
          rms += sample * sample;
        }
        rms = Math.min(1, Math.sqrt(rms / audio.time.length) * 4);
      }
      const rawLevel = props.audioLevel ?? 0;
      const clampedLevel = Number.isFinite(rawLevel) ? Math.min(1, Math.max(0, rawLevel)) : 0;
      const target =
        !reduced && (state.base === "listening" || state.base === "speaking")
          ? Math.min(1, audio ? rms : clampedLevel)
          : 0;
      const energyMix = reduced ? 1 : 1 - Math.exp(-dt / (target > energy ? 0.045 : 0.18));
      energy += (target - energy) * energyMix;
      const pointerMix = reduced ? 1 : 1 - Math.exp(-dt / 0.095);
      pointerX += ((reduced ? 0 : pointer.x) - pointerX) * pointerMix;
      pointerY += ((reduced ? 0 : pointer.y) - pointerY) * pointerMix;
      if (!reduced) {
        clock += dt;
        gyroClock += dt * (1 + 2 * thinking);
      }
      if (!reduced && speaking > 0.1 && energy > 0.26 && energy > previousEnergy && time - lastPeak > 280) {
        rippleTimes[rippleIndex++ % 4] = clock;
        lastPeak = time;
      }
      previousEnergy = energy;

      const motion = reduced ? 0 : clock;
      const phase = reduced ? 0 : gyroClock;
      const flash = Math.max(0, 1 - (time - errorStart) / 300);
      const radius = size * 0.445;
      const breath = reduced
        ? 1
        : 1 + 0.02 * Math.sin((motion * TAU) / 4) * (1 - listening) * (1 - thinking) * (1 - speaking);
      const voiceColor = voiceColors[Math.round(listening * 60)] ?? colors[0];

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.scale(radius, radius);

      ctx.fillStyle = halo;
      ctx.globalAlpha = 0.72 + energy * 0.28;
      ctx.fillRect(-1.1, -1.1, 2.2, 2.2);

      ctx.globalAlpha = 1;
      ctx.fillStyle = shell;
      ctx.beginPath();
      ctx.arc(0, 0, 0.735 * breath, 0, TAU);
      ctx.fill();

      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = 1 / radius;

      // 1. Tactical ticks, cardinal markers and counter-rotating segmented arcs.
      ctx.strokeStyle = colors[0];
      ctx.globalAlpha = 0.26;
      ctx.beginPath();
      for (let n = 0; n < 72; n++) {
        const angle = (n * TAU) / 72;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const inner = n % 3 === 0 ? 0.93 : 0.965;
        ctx.moveTo(c * inner, s * inner);
        ctx.lineTo(c, s);
      }
      ctx.stroke();

      ctx.strokeStyle = voiceColor;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      for (let n = 0; n < 4; n++) {
        const a = (n * TAU) / 4;
        ctx.moveTo(Math.cos(a - 0.025) * 1.035, Math.sin(a - 0.025) * 1.035);
        ctx.lineTo(Math.cos(a) * 0.98, Math.sin(a) * 0.98);
        ctx.lineTo(Math.cos(a + 0.025) * 1.035, Math.sin(a + 0.025) * 1.035);
      }
      ctx.stroke();

      ctx.lineWidth = 1.5 / radius;
      for (let band = 0; band < 3; band++) {
        const angle = (motion * (band === 1 ? -4 : 6) * Math.PI) / 180 + band * 2;
        ctx.strokeStyle = voiceColor;
        ctx.globalAlpha = 0.5 * (1 - thinking);
        ctx.beginPath();
        for (let part = 0; part < 3; part++) {
          const a = angle + part * 0.36;
          ctx.arc(0, 0, 0.88 + band * 0.025, a, a + 0.28);
        }
        ctx.stroke();
        ctx.strokeStyle = thinkingColor;
        ctx.globalAlpha = thinking * 0.8;
        ctx.stroke();
      }

      // Live radial waveform when audio is active.
      if (!reduced && energy > 0.025 && (listening > 0.1 || speaking > 0.1)) {
        ctx.strokeStyle = voiceColor;
        ctx.globalAlpha = 0.25 + energy * 0.6;
        ctx.lineWidth = (1.3 + energy * 1.2) / radius;
        ctx.beginPath();
        const samples = audio?.time;
        for (let n = 0; n < 64; n++) {
          const sample = samples?.length ? ((samples[Math.floor((n * samples.length) / 64)] ?? 128) - 128) / 128 : 0;
          const r = 0.79 + energy * 0.055 + sample * 0.085;
          const x = (circle[n * 2] ?? 0) * r;
          const y = (circle[n * 2 + 1] ?? 0) * r;
          if (n === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      }

      // 2. Sixteen closed plasma filaments, grouped into three color strokes.
      ctx.shadowBlur = HUD_QUALITY[quality].blur && !reduced ? 3 : 0;
      ctx.shadowColor = voiceColor;
      const step = quality === "ALTA" && !reduced ? 1 : 2;
      for (let group = 0; group < 3; group++) {
        ctx.strokeStyle = group === 0 ? colors[1] : group === 1 ? colors[2] : colors[3];
        ctx.globalAlpha = group === 2 ? 0.24 : 0.48 + energy * 0.18;
        ctx.lineWidth = 1 / radius;
        ctx.beginPath();
        for (let strand = group; strand < 16; strand += 3) {
          for (let n = 0; n <= 64; n += step) {
            const c = circle[n * 2] ?? 0;
            const s = circle[n * 2 + 1] ?? 0;
            const noise = simplex3(c * 1.7 + strand * 0.37, s * 1.7, motion * 0.22 + strand);
            const r = (0.73 + (strand - 7.5) * 0.005 + noise * (0.035 + energy * 0.06)) * breath;
            if (n === 0) ctx.moveTo(c * r, s * r);
            else ctx.lineTo(c * r, s * r);
          }
          ctx.closePath();
        }
        ctx.stroke();
      }
      ctx.shadowBlur = 0;

      ctx.save();
      ctx.rotate(pointerX * 0.6 + pointerY * 0.3);
      ctx.strokeStyle = rim;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2.1 / radius;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(0, 0, 0.736 * breath, -2.88, -0.84);
      ctx.stroke();
      ctx.globalAlpha = 0.52;
      ctx.beginPath();
      ctx.arc(0, 0, 0.744 * breath, 0.12, 1.65);
      ctx.stroke();
      ctx.restore();

      // 3. Tilted gyroscopes: dim rear half, luminous front half.
      ctx.strokeStyle = voiceColor;
      ctx.lineWidth = 1.1 / radius;
      for (let ring = 0; ring < 3; ring++) {
        const tilt = ((ring === 0 ? 62 : ring === 1 ? 74 : 81) * Math.PI) / 180;
        ctx.save();
        ctx.rotate((ring * TAU) / 3 + phase * (ring === 1 ? -0.13 : 0.1) + pointerX * 0.32);
        for (let half = 0; half < 2; half++) {
          ctx.globalAlpha = half === 0 ? 0.16 : 0.72;
          ctx.beginPath();
          ctx.ellipse(0, 0, 0.73, 0.73 * Math.cos(tilt + pointerY * 0.18), 0, half * Math.PI, (half + 1) * Math.PI);
          ctx.stroke();
        }
        ctx.restore();
      }

      // 4. Filled neural core. Fixed 8x8 spatial hash, reusable edge buffers.
      const contraction = breath * (1 - 0.06 * listening * energy + 0.025 * speaking * energy);
      ctx.save();
      ctx.scale(contraction, contraction);
      ctx.save();
      ctx.translate(-0.12 + pointerX * 0.29, -0.17 + pointerY * 0.29);
      const lightSize = 0.47 + energy * 0.14;
      ctx.scale(lightSize, lightSize);
      ctx.fillStyle = light;
      ctx.globalAlpha = 0.71 + energy * 0.29;
      ctx.fillRect(-1, -1, 2, 2);
      ctx.restore();

      const count = Math.round(45 * HUD_QUALITY[quality].particleScale);
      heads.fill(-1);
      const rotation = motion * 0.07 + pointerX * 0.54;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const tiltCos = Math.cos(pointerY * 0.46);
      const tiltSin = Math.sin(pointerY * 0.46);
      for (let n = 0; n < count; n++) {
        const p = n * 3;
        const x = (anchors[p] ?? 0) + Math.sin(motion * 0.19 + n) * 0.035;
        const y = (anchors[p + 1] ?? 0) + Math.cos(motion * 0.17 + n * 2) * 0.035;
        const z = (anchors[p + 2] ?? 0) + Math.sin(motion * 0.13 + n * 3) * 0.035;
        const yawDepth = x * sin + z * cos;
        const depth = yawDepth * tiltCos - y * tiltSin;
        points[p] = (x * cos - z * sin) * (1 + depth * 0.18);
        points[p + 1] = (y * tiltCos + yawDepth * tiltSin) * (1 + depth * 0.18);
        points[p + 2] = depth;
        const gx = Math.max(0, Math.min(7, Math.floor(((points[p] ?? 0) + 1) * 4)));
        const gy = Math.max(0, Math.min(7, Math.floor(((points[p + 1] ?? 0) + 1) * 4)));
        const cell = gx + gy * 8;
        next[n] = heads[cell] ?? -1;
        heads[cell] = n;
      }

      let edges = 0;
      for (let n = 0; n < count; n++) {
        const p = n * 3;
        const gx = Math.floor(((points[p] ?? 0) + 1) * 4);
        const gy = Math.floor(((points[p + 1] ?? 0) + 1) * 4);
        for (let y = Math.max(0, gy - 1); y <= Math.min(7, gy + 1); y++) {
          for (let x = Math.max(0, gx - 1); x <= Math.min(7, gx + 1); x++) {
            for (let other = heads[x + y * 8] ?? -1; other !== -1; other = next[other] ?? -1) {
              if (other <= n) continue;
              const q = other * 3;
              const dx = (points[p] ?? 0) - (points[q] ?? 0);
              const dy = (points[p + 1] ?? 0) - (points[q + 1] ?? 0);
              const distance = Math.sqrt(dx * dx + dy * dy);
              if (distance >= 0.25) continue;
              edgeA[edges] = n;
              edgeB[edges] = other;
              edgeBand[edges++] = Math.min(3, Math.floor((1 - distance / 0.25) * 4));
            }
          }
        }
      }

      ctx.strokeStyle = voiceColor;
      ctx.lineWidth = 0.8 / radius;
      for (let band = 0; band < 4; band++) {
        ctx.globalAlpha = 0.15 + band * 0.18;
        ctx.beginPath();
        for (let e = 0; e < edges; e++) {
          if (edgeBand[e] !== band) continue;
          const p = (edgeA[e] ?? 0) * 3;
          const q = (edgeB[e] ?? 0) * 3;
          ctx.moveTo(points[p] ?? 0, points[p + 1] ?? 0);
          ctx.lineTo(points[q] ?? 0, points[q + 1] ?? 0);
        }
        ctx.stroke();
      }

      ctx.fillStyle = colors[3];
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      for (let n = 0; n < count; n++) {
        const p = n * 3;
        const r = (1.5 + (points[p + 2] ?? 0) * 0.65) / radius;
        const px = points[p] ?? 0;
        const py = points[p + 1] ?? 0;
        ctx.moveTo(px + r, py);
        ctx.arc(px, py, r, 0, TAU);
      }
      ctx.fill();

      if (thinking > 0.01 && !reduced) {
        ctx.globalAlpha = thinking;
        ctx.beginPath();
        for (let e = 0; e < edges; e += 3) {
          const p = (edgeA[e] ?? 0) * 3;
          const q = (edgeB[e] ?? 0) * 3;
          const t = (motion * 0.65 + e * 0.137) % 1;
          const px = points[p] ?? 0;
          const py = points[p + 1] ?? 0;
          const x = px + ((points[q] ?? 0) - px) * t;
          const y = py + ((points[q + 1] ?? 0) - py) * t;
          ctx.moveTo(x + 1.6 / radius, y);
          ctx.arc(x, y, 1.6 / radius, 0, TAU);
        }
        ctx.fill();
      }
      ctx.restore();

      ctx.strokeStyle = voiceColor;
      if (!reduced) {
        for (let n = 0; n < 4; n++) {
          const age = clock - (rippleTimes[n] ?? -10000);
          if (age < 0 || age > 1.4) continue;
          ctx.globalAlpha = (1 - age / 1.4) * speaking * 0.5;
          ctx.beginPath();
          ctx.arc(0, 0, 0.2 + age * 0.53, 0, TAU);
          ctx.stroke();
        }
      }

      if (overlay > 0.001) {
        ctx.strokeStyle = colors[5];
        ctx.globalAlpha = overlay * (reduced ? 0.7 : 0.55 + 0.25 * Math.sin((motion * TAU) / 3));
        ctx.lineWidth = 2 / radius;
        ctx.beginPath();
        ctx.arc(0, 0, 1.055, -Math.PI * 0.7, Math.PI * 0.15);
        ctx.stroke();
      }
      if (flash > 0) {
        ctx.strokeStyle = colors[6];
        ctx.fillStyle = colors[6];
        ctx.globalAlpha = flash * 0.8;
        ctx.lineWidth = 2 / radius;
        ctx.beginPath();
        ctx.arc(0, 0, 0.9, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = flash * 0.16;
        ctx.beginPath();
        ctx.arc(0, 0, 0.65, 0, TAU);
        ctx.fill();
      }
      if (quality !== "ECONOMIA" && props.qualityTier !== "ECONOMIA") {
        const pulse = props.handoffPulse ? (reduced ? 1 : 1.3 + 0.3 * Math.sin(motion * TAU * 2)) : 0;
        sats.forEach((sat, index) => {
          ctx.fillStyle = satelliteColors[index] ?? colors[0];
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(sat.x, sat.y, 3 / radius, 0, TAU);
          ctx.fill();
          if (pulse) {
            ctx.strokeStyle = satelliteColors[index] ?? colors[0];
            ctx.lineWidth = 1 / radius;
            ctx.globalAlpha = 0.7;
            ctx.beginPath();
            ctx.arc(sat.x, sat.y, (4 + pulse * 3) / radius, 0, TAU);
            ctx.stroke();
          }
        });
      }
      ctx.restore();
    };

    const unregister = hudAnimationLoop.register(render, { element: container });
    return () => {
      unregister();
      sizing.disconnect();
    };
  });

  return (
    <div
      ref={containerRef}
      class={["jarvis-orb-container", props.class].filter(Boolean).join(" ")}
      role="img"
      aria-label={t("island.jarvis.orbLabel", { status: orbStatusText() })}
      onPointerMove={trackPointer}
      onPointerLeave={resetPointer}
      onPointerCancel={resetPointer}
    >
      <canvas ref={canvasRef} class="jarvis-orb-canvas" />
      <Show when={props.qualityTier !== "ECONOMIA" && satellites().length > 0}>
        <svg class="jarvis-orb-satellites" viewBox="0 0 100 100" aria-hidden="true">
          <For each={satellites()}>
            {(sat) => (
              <g style={{ color: sat.color }}>
                <title>{sat.name || sat.id}</title>
                <circle cx={50 + sat.x * 44.5} cy={50 + sat.y * 44.5} r="0.9" fill="currentColor" />
                <Show when={props.handoffPulse}>
                  <circle
                    cx={50 + sat.x * 44.5}
                    cy={50 + sat.y * 44.5}
                    r="2"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="0.4"
                  />
                </Show>
              </g>
            )}
          </For>
        </svg>
      </Show>
    </div>
  );
}
