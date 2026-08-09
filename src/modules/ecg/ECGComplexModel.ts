import type { ECGComplexConfig, ECGComplex, RhythmLabel } from './types';
import { ECG_PHASE_DEFAULTS } from './types';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function gaussian(t: number, mu: number, sigma: number, amplitude: number): number {
  const x = (t - mu) / Math.max(sigma, 1e-6);
  return amplitude * Math.exp(-0.5 * x * x);
}

export function generateECGComplex(
  rrMs: number,
  config: ECGComplexConfig,
  options?: { sampleRateHz?: number; rScale?: number; seed?: number }
): { samples: Array<{ t: number; y: number }>; durationMs: number } {
  const sampleRateHz = options?.sampleRateHz ?? 60;
  const rScale = options?.rScale ?? 1;
  const safeRr = rrMs > 0 ? rrMs : 800;
  const durationMs = clamp(0.6 * safeRr, 420, 1050);
  const phases = { ...ECG_PHASE_DEFAULTS };
  const pStart = phases.pStart * durationMs;
  const pWidth = phases.pWidth * durationMs;
  const prSegment = phases.prSegment * durationMs;
  const qrsStart = phases.qrsStart * durationMs;
  const qrsWidth = phases.qrsWidth * durationMs * config.qrsWidthRatio;
  const stStart = phases.stStart * durationMs;
  const stWidth = phases.stWidth * durationMs;
  const tStart = phases.tStart * durationMs;
  const tWidth = phases.tWidth * durationMs;

  const qCenter = qrsStart - qrsWidth * 0.15;
  const rCenter = qrsStart + qrsWidth * 0.25;
  const sCenter = qrsStart + qrsWidth * 0.65;
  const pCenter = pStart + pWidth * 0.5;
  const tCenter = tStart + tWidth * 0.5;

  const qSigma = Math.max(qrsWidth * 0.18, 0.01);
  const rSigma = Math.max(qrsWidth * 0.14, 0.01);
  const sSigma = Math.max(qrsWidth * 0.18, 0.01);
  const pSigma = Math.max(pWidth * 0.28, 0.01);
  const tSigma = Math.max(tWidth * 0.28, 0.01);

  const samples: Array<{ t: number; y: number }> = [];
  const steps = Math.max(40, Math.round((durationMs / 1000) * sampleRateHz));

  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * durationMs;
    let y = 0;

    if (config.hasPWave && t >= pStart && t <= pStart + pWidth) {
      y += gaussian(t, pCenter, pSigma, config.pAmplitude);
    }

    if (t >= qCenter - qSigma * 2 && t <= sCenter + sSigma * 2) {
      y += gaussian(t, qCenter, qSigma, config.qAmplitude);
      y += gaussian(t, rCenter, rSigma, config.rAmplitude * rScale);
      y += gaussian(t, sCenter, sSigma, config.sAmplitude);
    }

    const stEnd = stStart + stWidth;
    if (t >= stStart && t <= stEnd) {
      const stProgress = (t - stStart) / Math.max(stWidth, 1e-6);
      y += config.stElevation * Math.sin(stProgress * Math.PI);
    }

    if (t >= tStart && t <= tStart + tWidth) {
      y += gaussian(t, tCenter, tSigma, config.tAmplitude);
    }

    samples.push({ t, y: clamp(y, -1.6, 1.6) });
  }

  return { samples, durationMs };
}

export function rhythmFromStatus(
  arrhythmiaStatus: string | undefined,
  bpm: number,
  rrIntervals: number[]
): RhythmLabel {
  const status = (arrhythmiaStatus || '').toUpperCase();
  if (status.includes('PVC')) return 'PVC';
  if (status.includes('AF')) return 'AF';
  if (status.includes('PAC')) return 'PAC';

  if (rrIntervals.length >= 8) {
    const mean = rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length;
    const variance = rrIntervals.reduce((sum, rr) => sum + (rr - mean) ** 2, 0) / rrIntervals.length;
    const cv = Math.sqrt(variance) / Math.max(mean, 1);
    if (cv > 0.12) return 'AF';
  }

  if (bpm > 100) return 'TACHY';
  if (bpm > 0 && bpm < 60) return 'BRADY';
  return 'NSR';
}

export function rhythmConfig(rhythm: RhythmLabel): ECGComplexConfig {
  switch (rhythm) {
    case 'PVC':
      return {
        pAmplitude: 0,
        qAmplitude: -0.25,
        rAmplitude: 1.05,
        sAmplitude: -0.35,
        tAmplitude: 0.22,
        qrsWidthRatio: 1.4,
        hasPWave: false,
        stElevation: -0.04,
      };
    case 'PAC':
      return {
        pAmplitude: 0.22,
        qAmplitude: -0.1,
        rAmplitude: 1.0,
        sAmplitude: -0.18,
        tAmplitude: 0.28,
        qrsWidthRatio: 0.82,
        hasPWave: true,
        stElevation: 0,
      };
    case 'AF':
      return {
        pAmplitude: 0,
        qAmplitude: -0.18,
        rAmplitude: 0.95,
        sAmplitude: -0.28,
        tAmplitude: 0.24,
        qrsWidthRatio: 1.0,
        hasPWave: false,
        stElevation: 0,
      };
    case 'TACHY':
      return {
        pAmplitude: 0.18,
        qAmplitude: -0.12,
        rAmplitude: 1.0,
        sAmplitude: -0.22,
        tAmplitude: 0.3,
        qrsWidthRatio: 1.0,
        hasPWave: true,
        stElevation: 0.02,
      };
    case 'BRADY':
      return {
        pAmplitude: 0.2,
        qAmplitude: -0.14,
        rAmplitude: 1.0,
        sAmplitude: -0.24,
        tAmplitude: 0.34,
        qrsWidthRatio: 1.0,
        hasPWave: true,
        stElevation: 0,
      };
    default:
      return {
        pAmplitude: 0.18,
        qAmplitude: -0.14,
        rAmplitude: 1.0,
        sAmplitude: -0.24,
        tAmplitude: 0.3,
        qrsWidthRatio: 1.0,
        hasPWave: true,
        stElevation: 0,
      };
  }
}