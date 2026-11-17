export type SoundKind = "send" | "complete" | "attention" | "error";

interface SoundOptions {
  enabled: boolean;
  volume: number;
}

let context: AudioContext | null = null;
const lastPlayed = new Map<SoundKind, number>();

function ensureContext(): AudioContext | null {
  if (context) return context;
  try {
    const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) return null;
    context = new Constructor();
  } catch {
    return null;
  }
  return context;
}

export function unlockSounds(): void {
  const ctx = ensureContext();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
}

export function playSound(kind: SoundKind, options: SoundOptions): void {
  if (!options.enabled || options.volume <= 0) return;
  const now = Date.now();
  if (now - (lastPlayed.get(kind) ?? 0) < 900) return;
  lastPlayed.set(kind, now);
  const ctx = ensureContext();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  const volume = Math.min(0.8, Math.max(0, options.volume));
  try {
    switch (kind) {
      case "send":
        tone(ctx, 540, 0, 0.055, volume * 0.16, "sine");
        tone(ctx, 460, 0.045, 0.05, volume * 0.12, "sine");
        break;
      case "complete":
        tone(ctx, 660, 0, 0.12, volume * 0.22, "triangle");
        tone(ctx, 880, 0.09, 0.16, volume * 0.2, "triangle");
        break;
      case "attention":
        tone(ctx, 740, 0, 0.12, volume * 0.26, "sine");
        tone(ctx, 988, 0.125, 0.14, volume * 0.22, "sine");
        break;
      case "error":
        tone(ctx, 220, 0, 0.16, volume * 0.24, "sawtooth");
        tone(ctx, 165, 0.12, 0.2, volume * 0.18, "sawtooth");
        break;
    }
  } catch {
    /* audio is best-effort */
  }
}

function tone(ctx: AudioContext, frequency: number, delay: number, duration: number, volume: number, type: OscillatorType): void {
  const start = ctx.currentTime + delay;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}
