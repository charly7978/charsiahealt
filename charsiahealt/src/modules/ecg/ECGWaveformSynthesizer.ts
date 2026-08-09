import type { ECGComplex, ECGValuePoint, ECGWaveformSynthesizerConfig, RhythmLabel } from './types';
import { generateECGComplex, rhythmConfig } from './ECGComplexModel';

const DEFAULT_SAMPLE_RATE_HZ = 60;
const MAX_ACTIVE_COMPLEXES = 24;
const RESPIRATORY_AMPLITUDE_MOD = 0.12;
const JITTER_MS = 12;

export class ECGWaveformSynthesizer {
  private readonly sampleRateHz: number;
  private readonly maxActiveComplexes: number;
  private readonly respiratoryAmplitudeMod: number;
  private readonly jitterMs: number;

  private activeComplexes: ECGComplex[] = [];
  private lastSampleTime = 0;
  private lastBeatTime = 0;
  private respiratoryPhase = 0;
  private currentRhythm: RhythmLabel = 'NSR';

  constructor(config: ECGWaveformSynthesizerConfig = {}) {
    this.sampleRateHz = config.sampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
    this.maxActiveComplexes = config.maxActiveComplexes ?? MAX_ACTIVE_COMPLEXES;
    this.respiratoryAmplitudeMod = config.respiratoryAmplitudeMod ?? RESPIRATORY_AMPLITUDE_MOD;
    this.jitterMs = config.jitterMs ?? JITTER_MS;
  }

  onHeartBeat(peakTimeMs: number, rrMs: number, rhythm: RhythmLabel): ECGComplex | null {
    if (peakTimeMs - this.lastBeatTime < 250) {
      return null;
    }

    this.lastBeatTime = peakTimeMs;
    this.currentRhythm = rhythm;

    const config = rhythmConfig(rhythm);
    const jitter = (Math.random() - 0.5) * 2 * this.jitterMs;
    this.respiratoryPhase += (Math.PI * 2) / 4;
    const respiratoryMod = 1 + this.respiratoryAmplitudeMod * Math.sin(this.respiratoryPhase);
    const rScale = clamp(respiratoryMod + (Math.random() - 0.5) * 0.04, 0.7, 1.25);

    const complex = generateECGComplex(Math.max(rrMs, 420), config, {
      sampleRateHz: this.sampleRateHz,
      rScale,
    });

    const ecgComplex: ECGComplex = {
      rPeakTime: peakTimeMs,
      durationMs: complex.durationMs,
      rrMs,
      rhythm,
      rScale,
      hasP: config.hasPWave,
      isWideQrs: config.qrsWidthRatio > 1.15,
      samples: complex.samples,
    };

    this.activeComplexes.push(ecgComplex);
    if (this.activeComplexes.length > this.maxActiveComplexes) {
      this.activeComplexes.shift();
    }

    return ecgComplex;
  }

  sample(untilTimeMs: number): ECGValuePoint[] {
    if (this.activeComplexes.length === 0) {
      this.lastSampleTime = untilTimeMs;
      return [];
    }

    const points: ECGValuePoint[] = [];
    const dt = 1000 / this.sampleRateHz;
    const startTime = Math.max(this.lastSampleTime, this.activeComplexes[0]?.rPeakTime ?? untilTimeMs);

    for (let t = startTime; t <= untilTimeMs; t += dt) {
      let y = 0;
      let isPeak = false;
      let rhythm: RhythmLabel = this.currentRhythm;
      let isArrhythmia = false;

      for (const complex of this.activeComplexes) {
        const age = t - complex.rPeakTime;
        if (age < 0 || age > complex.durationMs) continue;

        const phase = age / complex.durationMs;
        const sampleIndex = Math.min(
          Math.floor(phase * (complex.samples.length - 1)),
          complex.samples.length - 1
        );
        const sample = complex.samples[sampleIndex];
        y += sample.y * complex.rScale;

        if (sampleIndex > 0 && complex.samples[sampleIndex - 1].y < sample.y && sample.y > 0.85) {
          isPeak = true;
        }

        rhythm = complex.rhythm;
        isArrhythmia = complex.rhythm !== 'NSR';
      }

      if (y !== 0) {
        points.push({
          time: t,
          y: clamp(y, -1.6, 1.6),
          isPeak,
          rhythm,
          isArrhythmia,
        });
      }
    }

    this.lastSampleTime = untilTimeMs;
    this.activeComplexes = this.activeComplexes.filter((c) => untilTimeMs - c.rPeakTime < c.durationMs * 1.2);

    return points;
  }

  reset(): void {
    this.activeComplexes = [];
    this.lastSampleTime = 0;
    this.lastBeatTime = 0;
    this.respiratoryPhase = 0;
    this.currentRhythm = 'NSR';
  }

  getBufferedPoints(): ECGValuePoint[] {
    return this.sample(Date.now());
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}