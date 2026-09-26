/** Synthesized sound for the sample games: no audio files to host. The context starts on the player's first gesture. */
export function createSynth(storageKey = 'hookedin:muted') {
  let context: AudioContext | null = null,
    master: GainNode | null = null,
    muted = false;
  try {
    muted = localStorage.getItem(storageKey) === '1';
  } catch {}
  /** Sound decorates a game and never stops one: a browser without Web Audio, or one that refuses a context, plays it
   * silently, since `unlock` runs in the handler of the very click that plays. */
  function unlock() {
    try {
      if (!context) {
        const created = new AudioContext();
        master = created.createGain();
        master.gain.value = muted ? 0 : 1;
        master.connect(created.destination);
        context = created;
      }
      if (context.state === 'suspended') void context.resume().catch(() => {});
    } catch {}
  }
  function tone(
    frequency: number,
    delay: number,
    duration: number,
    { type = 'sine' as OscillatorType, gain = 0.1, to = frequency } = {},
  ) {
    if (!context || !master) return;
    const start = context.currentTime + delay,
      oscillator = context.createOscillator(),
      envelope = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (to !== frequency) oscillator.frequency.exponentialRampToValueAtTime(to, start + duration);
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(gain, start + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope).connect(master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }
  function noise(delay: number, duration: number, gain: number, cutoff: number) {
    if (!context || !master) return;
    const length = Math.ceil(context.sampleRate * duration),
      buffer = context.createBuffer(1, length, context.sampleRate),
      data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    const source = context.createBufferSource(),
      filter = context.createBiquadFilter(),
      envelope = context.createGain();
    source.buffer = buffer;
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    envelope.gain.value = gain;
    source.connect(filter).connect(envelope).connect(master);
    source.start(context.currentTime + delay);
  }
  const melody = (notes: number[], step: number, options: Parameters<typeof tone>[3] = {}) =>
    notes.forEach((note, i) => tone(note, i * step, step * 2.2, options));
  return {
    unlock,
    tone,
    noise,
    melody,
    get muted() {
      return muted;
    },
    setMuted(value: boolean) {
      muted = value;
      if (master) master.gain.value = value ? 0 : 1;
      try {
        localStorage.setItem(storageKey, value ? '1' : '0');
      } catch {}
    },
    /** For sounds that outlast one envelope; null until the first gesture. */
    get output() {
      return context && master ? { context, master } : null;
    },
  };
}
