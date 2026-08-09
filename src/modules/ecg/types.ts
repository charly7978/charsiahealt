/**
 * Tipos del modelo de ECG sintetizado (P-QRS-T).
 *
 * El sintetizador consume los latidos REALES detectados por el pipeline PPG
 * (`isPeak`, `rrIntervals`, `arrhythmiaStatus`, `bpm`) y emite puntos de
 * onda ECG con morfología fisiológica anclada 1:1 a la actividad cardíaca.
 */

/** Fases fisiológicas de un complejo P-QRS-T, como fracción del intervalo RR [0..1]. */
export const ECG_PHASE_DEFAULTS = {
  pStart: 0.02, // inicio onda P
  pWidth: 0.1, // duración onda P (~80–110 ms escalado)
  prSegment: 0.06, // segmento PR isoeléctrico
  qrsStart: 0.18, // inicio complejo QRS
  qrsWidth: 0.1, // duración QRS (~80–120 ms escalado)
  stStart: 0.28, // inicio segmento ST
  stWidth: 0.12, // duración ST
  tStart: 0.4, // inicio onda T
  tWidth: 0.16, // duración T (~160 ms escalado)
  tpEnd: 1.0, // fin de pausa TP (inicio siguiente ciclo)
} as const;

/** Amplitudes relativas a la onda R (R = 1). Config por ritmo. */
export interface ECGComplexConfig {
  /** 0.15–0.25 */
  pAmplitude: number;
  /** -0.15…-0.25 (0 si ausente) */
  qAmplitude: number;
  /** 1.0 */
  rAmplitude: number;
  /** -0.20…-0.40 */
  sAmplitude: number;
  /** 0.25–0.40 */
  tAmplitude: number;
  /** 1.0 NSR · 1.4 (QW) PVC · 0.8 PAC */
  qrsWidthRatio: number;
  /** false en PVC / AF */
  hasPWave: boolean;
  /** 0 normal · ±0.05 (elevación/depresión ST) */
  stElevation: number;
}

/** Ritmos soportados por el sintetizador. */
export type RhythmLabel = 'NSR' | 'PVC' | 'PAC' | 'AF' | 'TACHY' | 'BRADY';

/** Un complejo P-QRS-T concreto, escalado al RR real. */
export interface ECGComplex {
  /** timestamp ms del pico R (latido real detectado) */
  rPeakTime: number;
  /** offset en ms desde el inicio del complejo (onda P) hasta el pico R */
  rPeakOffsetMs: number;
  /** clamp(0.6 × RR, 420, 1050) */
  durationMs: number;
  /** intervalo RR real que lo genera */
  rrMs: number;
  rhythm: RhythmLabel;
  /** modulación respiratoria + jitter */
  rScale: number;
  hasP: boolean;
  isWideQrs: boolean;
  /** muestras a 60 Hz, t relativo al inicio del complejo (ms) */
  samples: Array<{ t: number; y: number }>;
}

/** Lote emitido por el sintetizador. */
export interface ECGValuePoint {
  time: number;
  y: number;
  isPeak: boolean;
  rhythm: RhythmLabel;
  isArrhythmia: boolean;
}

export interface ECGWaveformSynthesizerConfig {
  /** Hz de muestreo de salida (por defecto 60) */
  sampleRateHz?: number;
  /** máx. complejos activos en cola FIFO (por defecto 24) */
  bufferSize?: number;
  /** latidos < este ms tras el anterior se ignoran (refractario, por defecto 250) */
  refractoryMs?: number;
  /** amplitud base de la modulación respiratoria (por defecto 1) */
  rScaleBase?: number;
}
