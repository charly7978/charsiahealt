// Sonido de finalización de medición usando Web Audio API
let audioCtx: AudioContext | null = null;

const getAudioContext = (): AudioContext => {
  if (!audioCtx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    audioCtx = new Ctor();
  }
  return audioCtx;
};

/**
 * Tono de finalización profesional: triple beep ascendente
 */
export const playCompletionSound = () => {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    const frequencies = [880, 1100, 1320]; // A5, C#6, E6 (acorde mayor)
    const durations = [0.12, 0.12, 0.25];
    let offset = 0;

    frequencies.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + offset);

      gain.gain.setValueAtTime(0, now + offset);
      gain.gain.linearRampToValueAtTime(0.3, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + durations[i]);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + offset);
      osc.stop(now + offset + durations[i] + 0.05);

      offset += durations[i] + 0.06;
    });
  } catch (e) {
    console.log('Audio no disponible:', e);
  }
};
