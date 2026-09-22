/** Samson's Gold sound cues, played on the shared synthesizer. */
import { createSynth } from '@hookedin/play/sdk/synth';

export function createSound() {
  const synth = createSynth(),
    { tone, noise, melody } = synth;
  return {
    unlock: synth.unlock,
    get muted() {
      return synth.muted;
    },
    setMuted: synth.setMuted,
    spin() {
      noise(0, 0.35, 0.05, 900);
      tone(140, 0, 0.3, { type: 'triangle', gain: 0.06, to: 320 });
    },
    stop(reel: number) {
      noise(0, 0.09, 0.16, 500);
      tone(92 + reel * 6, 0, 0.12, { type: 'sine', gain: 0.22, to: 55 });
    },
    scatter(count: number) {
      melody(
        [660, 880, 1320].map(f => f * 2 ** ((count - 1) / 6)),
        0.07,
        { type: 'triangle', gain: 0.12 },
      );
    },
    /** A rising shimmer while the last reel is held back; returns its stop function. */
    anticipation(duration: number) {
      const output = synth.output;
      if (!output) return () => {};
      const { context, master } = output;
      const oscillator = context.createOscillator(),
        tremolo = context.createGain();
      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(220, context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(880, context.currentTime + duration);
      tremolo.gain.value = 0.035;
      oscillator.connect(tremolo).connect(master);
      oscillator.start();
      return () => {
        tremolo.gain.setTargetAtTime(0, context.currentTime, 0.04);
        oscillator.stop(context.currentTime + 0.3);
      };
    },
    tick() {
      tone(1400, 0, 0.04, { type: 'square', gain: 0.025 });
    },
    /** Tier 0 is an ordinary win; 1–3 are the big-win celebrations. */
    win(tier: number) {
      const scale = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568, 2093];
      melody(scale.slice(0, 4 + tier), 0.085, { type: 'triangle', gain: 0.13 });
      if (tier > 0) melody([261.63, 329.63, 392, 523.25], 0.17, { type: 'sawtooth', gain: 0.05 });
    },
    bonus() {
      melody([392, 523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5], 0.11, { type: 'triangle', gain: 0.14 });
      noise(0, 0.8, 0.04, 4000);
    },
  };
}
