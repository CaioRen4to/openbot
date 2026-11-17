/**
 * Plays a short two-tone tactical HUD confirmation chime via Web Audio.
 * Never throws when audio output or AudioContext is blocked.
 */
export function playJarvisWakeChime(): void {
  if (typeof AudioContext === "undefined") return;
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    const now = context.currentTime;

    const osc1 = context.createOscillator();
    const gain1 = context.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(587.33, now); // D5
    osc1.frequency.exponentialRampToValueAtTime(880, now + 0.08); // A5
    gain1.gain.setValueAtTime(0.0001, now);
    gain1.gain.exponentialRampToValueAtTime(0.11, now + 0.015);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    osc1.connect(gain1);
    gain1.connect(context.destination);
    osc1.start(now);
    osc1.stop(now + 0.17);

    const osc2 = context.createOscillator();
    const gain2 = context.createGain();
    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(1174.66, now + 0.075); // D6 harmonic shimmer
    gain2.gain.setValueAtTime(0.0001, now + 0.075);
    gain2.gain.exponentialRampToValueAtTime(0.07, now + 0.095);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    osc2.connect(gain2);
    gain2.connect(context.destination);
    osc2.start(now + 0.075);
    osc2.stop(now + 0.26);

    const ref = context;
    setTimeout(() => {
      void ref.close().catch(() => {});
    }, 350);
  } catch {
    void context?.close().catch(() => {});
  }
}
