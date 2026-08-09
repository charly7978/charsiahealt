export const ECG_PHASE_DEFAULTS = {
  pStart: 0.020,
  pWidth: 0.100,
  prSegment: 0.060,
  qrsStart: 0.180,
  qrsWidth: 0.100,
  stStart: 0.280,
  stWidth: 0.120,
  tStart: 0.400,
  tWidth: 0.160,
  tpEnd: 1.0,
} as const;

export interface ECGComplexConfig {
  pAmplitude: number;
  qAmplitude: number;
  rAmplitude: number;
  sAmplitude: number;
  tAmplitude: number;
  qrsWidthRatio: number;
  hasPWave: boolean;
  stElevation: number;
}

export type RhythmLabel = 'NSR' | 'PVC' | 'PAC' | 'AF' | 'TACHY' | 'BRADY';

export interface ECGComplex {
  rPeakTime: number;
  durationMs: number;
  rrMs: number;
  rhythm: RhythmLabel;
  rScale: number;
  hasP: boolean;
  isWideQrs: boolean;
  samples: Array<{ t: number; y: number }>;
}

export interface ECGValuePoint {
  time: number;
  y: number;
  isPeak: boolean;
  rhythm: RhythmLabel;
  isArrhythmia: boolean;
}

export interface ECGWaveformSynthesizerConfig {
  sampleRateHz?: number;
  maxActiveComplexes?: number;
  respiratoryAmplitudeMod?: number;
  jitterMs?: number;
}