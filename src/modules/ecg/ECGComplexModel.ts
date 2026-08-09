import { ECG_PHASE_DEFAULTS, type ECGComplex, type ECGComplexConfig, type RhythmLabel } from './types';

/**
 * Configuraciones por ritmo. Amplitudes relativas a R=1, morfología
 * fisiológica documentada en el plan (PVC = QRS ancho sin onda P,
 * PAC = QRS angosto + P prematura, AF = irregular con P aleatoria).
 */
const RHYTHM_CONFIGS: Record<RhythmLabel, ECGComplexConfig> = {
  NSR: {
    pAmplitude: 0.2,
    qAmplitude: -0.2,
    rAmplitude: 1.0,
    sAmplitude: -0.3,
    tAmplitude: 0.3,
    qrsWidthRatio: 1.0,
    hasPWave: true,
    stElevation: 0,
  },
  PVC: {
    pAmplitude: 0,
    qAmplitude: -0.28,
    rAmplitude: 1.06,
    sAmplitude: -0.42,
    tAmplitude: -0.28, // T invertida típica post-PVC
    qrsWidthRatio: 1.4,
    hasPWave: false,
    stElevation: -0.03,
  },
  PAC: {
    pAmplitude: 0.24, // P prematura y algo más prominente
    qAmplitude: -0.18,
    rAmplitude: 0.95,
    sAmplitude: -0.26,
    tAmplitude: 0.28,
    qrsWidthRatio: 0.8,
    hasPWave: true,
    stElevation: 0,
  },
  AF: {
    pAmplitude: 0.1, // ondas fibrilatorias ausentes (faltan P definidas)
    qAmplitude: -0.2,
    rAmplitude: 1.0,
    sAmplitude: -0.3,
    tAmplitude: 0.26,
    qrsWidthRatio: 1.0,
    hasPWave: false,
    stElevation: 0,
  },
  TACHY: {
    pAmplitude: 0.18, // P montada sobre la T previa (RR corto)
    qAmplitude: -0.18,
    rAmplitude: 1.0,
    sAmplitude: -0.28,
    tAmplitude: 0.26,
    qrsWidthRatio: 0.95,
    hasPWave: true,
    stElevation: 0,
  },
  BRADY: {
    pAmplitude: 0.22, // P prominente, TP largo
    qAmplitude: -0.2,
    rAmplitude: 1.0,
    sAmplitude: -0.3,
    tAmplitude: 0.34,
    qrsWidthRatio: 1.0,
    hasPWave: true,
    stElevation: 0,
  },
};

const DEFAULT_CONFIG: ECGComplexConfig = RHYTHM_CONFIGS.NSR;
const DEFAULT_SAMPLE_RATE_HZ = 60;
const MIN_DURATION_MS = 420;
const MAX_DURATION_MS = 1050;
/** El complejo P-QRS-T ocupa el 60% del intervalo RR; el resto es pausa TP. */
const COMPLEX_FRACTION = 0.6;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Gaussiana normalizada: A·exp(-((t-μ)²)/(2σ²)). */
const gaussian = (t: number, mu: number, sigma: number, amplitude: number): number => {
  const d = (t - mu) / Math.max(sigma, 1e-6);
  return amplitude * Math.exp(-(d * d) / 2);
};

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Duración del complejo: clamp(0.6 × RR, 420, 1050). RR inválido → 480 ms (fallback 800 ms). */
export function computeDurationMs(rrMs: number): number {
  const safeRR = rrMs > 0 ? rrMs : 800;
  return clamp(0.6 * safeRR, MIN_DURATION_MS, MAX_DURATION_MS);
}

/** Fracción del RR en la que cae el pico R (p.ej. ~0.138 para NSR). */
export function computeRPeakFraction(config: ECGComplexConfig): number {
  const centerFrac = ECG_PHASE_DEFAULTS.qrsStart + 0.5 * ECG_PHASE_DEFAULTS.qrsWidth * config.qrsWidthRatio;
  return centerFrac * COMPLEX_FRACTION;
}

/**
 * Evaluador puro del complejo P-QRS-T: devuelve y(t) en un instante `tMs`
 * dentro del complejo (t ∈ [0, durationMs]). Usado por el sintetizador
 * continuo en el hot path (sin asignaciones).
 */
export function evaluateECGComplex(
  tMs: number,
  rrMs: number,
  config: ECGComplexConfig,
  rScale = 1
): number {
  const durationMs = computeDurationMs(rrMs);

  const phases = ECG_PHASE_DEFAULTS;
  const tPStart = phases.pStart * durationMs;
  const tPWidth = phases.pWidth * durationMs;
  const tQRSStart = phases.qrsStart * durationMs;
  const tQRSWidth = phases.qrsWidth * durationMs * config.qrsWidthRatio;
  const tTStart = phases.tStart * durationMs;
  const tTWidth = phases.tWidth * durationMs;

  // Centros de las gaussianas.
  const muP = tPStart + tPWidth * 0.5;
  const muQ = tQRSStart + tQRSWidth * 0.15;
  const muR = tQRSStart + tQRSWidth * 0.5;
  const muS = tQRSStart + tQRSWidth * 0.85;
  const muT = tTStart + tTWidth * 0.5;

  // Desviaciones (la R es estrecha; P y T anchas).
  const sigmaP = Math.max(6, tPWidth * 0.28);
  const sigmaQ = Math.max(4, tQRSWidth * 0.16);
  const sigmaR = Math.max(4, tQRSWidth * 0.14);
  const sigmaS = Math.max(4, tQRSWidth * 0.18);
  const sigmaT = Math.max(10, tTWidth * 0.3);

  let y = gaussian(tMs, muP, sigmaP, config.pAmplitude * rScale);
  y += gaussian(tMs, muQ, sigmaQ, config.qAmplitude * rScale);
  y += gaussian(tMs, muR, sigmaR, config.rAmplitude * rScale);
  y += gaussian(tMs, muS, sigmaS, config.sAmplitude * rScale);
  y += gaussian(tMs, muT, sigmaT, config.tAmplitude * rScale);

  // ST: escalón suave (rama de seno) entre final QRS e inicio de T.
  const stElevation = config.stElevation * rScale;
  const stBegin = muS + sigmaS * 1.8;
  const stEnd = tTStart - sigmaT * 0.6;
  if (tMs >= stBegin && tMs <= stEnd) {
    const k = (tMs - stBegin) / Math.max(1, stEnd - stBegin);
    const ramp = Math.sin(Math.min(1, k) * Math.PI);
    y += stElevation * ramp;
  }

  return y;
}

export interface GenerateECGComplexOptions {
  sampleRateHz?: number;
  /** modulación respiratoria total: 1 = sin modulación · 0.88 = respiración honda */
  rScale?: number;
  seed?: number;
}

export interface GenerateECGComplexResult {
  samples: Array<{ t: number; y: number }>;
  durationMs: number;
  /** offset en ms desde el inicio del complejo hasta el pico R */
  rPeakOffsetMs: number;
}

/**
 * Genera un complejo P-QRS-T muestreado a `sampleRateHz`, escalado al RR real.
 * Se inserta una muestra exacta en el pico R para que el QRS nunca se pierda
 * por inframuestreo (la R es ~10x más estrecha que P/T).
 */
export function generateECGComplex(
  rrMs: number,
  config: ECGComplexConfig = DEFAULT_CONFIG,
  options?: GenerateECGComplexOptions
): GenerateECGComplexResult {
  const sampleRateHz = options?.sampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
  const rhythm = rrMs > 0 ? config : RHYTHM_CONFIGS.NSR;
  const durationMs = computeDurationMs(rrMs);

  const rand = options?.seed !== undefined ? mulberry32(options.seed) : Math.random;
  const jitter = 1 + (rand() - 0.5) * 0.04; // ±2%
  const rScale = (options?.rScale ?? 1) * jitter;

  // Grid uniforme a sampleRateHz.
  const sampleCount = Math.max(2, Math.round((durationMs / 1000) * sampleRateHz));
  const times: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    times.push((i / (sampleCount - 1)) * durationMs);
  }

  // Insertar muestra exacta en el pico R.
  const qrsCenterFrac = ECG_PHASE_DEFAULTS.qrsStart + 0.5 * ECG_PHASE_DEFAULTS.qrsWidth * rhythm.qrsWidthRatio;
  const muR = qrsCenterFrac * durationMs;
  if (!times.some((t) => Math.abs(t - muR) < 1e-6)) {
    times.push(muR);
    times.sort((a, b) => a - b);
  }

  const samples = times.map((t) => ({ t, y: evaluateECGComplex(t, rrMs, rhythm, rScale) }));
  return { samples, durationMs, rPeakOffsetMs: muR };
}

/**
 * Determina el ritmo a partir del estado de arritmia del pipeline real.
 *
 * `arrhythmiaStatus` usa el formato `"ARRITMIA DETECTADA|N"` / `"SIN ARRITMIAS|0"`.
 * Puede contener la etiqueta del tipo (AF/PVC/PAC); si no, se infiere del
 * patrón de RR y del BPM. Orden de precedencia: PVC > AF > PAC > TACHY > BRADY > NSR.
 */
export function rhythmFromStatus(
  arrhythmiaStatus: string | undefined,
  bpm: number,
  rrIntervals: number[]
): RhythmLabel {
  const status = arrhythmiaStatus ?? '';

  // Precedencia explícita de arritmias por contenido.
  if (status.includes('PVC')) return 'PVC';
  if (status.includes('AF') || status.includes('FA')) return 'AF';
  if (status.includes('PAC')) return 'PAC';

  // AF sostenida por irregularidad del RR (CV > 0.12), incluso sin etiqueta.
  if (rrIntervals.length >= 8) {
    const recent = rrIntervals.slice(-12);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (mean > 0) {
      const variance = recent.reduce((sum, v) => sum + (v - mean) ** 2, 0) / recent.length;
      const cv = Math.sqrt(variance) / mean;
      if (cv > 0.12) return 'AF';
    }
  }

  if (rrIntervals.length >= 3) {
    // Latido prematuro aislado: RR corto precedido por uno largo.
    const last = rrIntervals[rrIntervals.length - 1];
    const prev = rrIntervals[rrIntervals.length - 2];
    const prevPrev = rrIntervals.length >= 3 ? rrIntervals[rrIntervals.length - 3] : prev;
    if (prev > 0 && last > 0 && last < prev * 0.8 && prevPrev >= prev) {
      return 'PVC';
    }
  }

  if (bpm > 100) return 'TACHY';
  if (bpm > 0 && bpm < 60) return 'BRADY';
  return 'NSR';
}

/** Devuelve la config de morfología para un ritmo concreto. */
export function getRhythmConfig(rhythm: RhythmLabel): ECGComplexConfig {
  return RHYTHM_CONFIGS[rhythm] ?? DEFAULT_CONFIG;
}

/**
 * Construye el complejo completo (ECGComplex) para un latido real.
 * Conveniencia para el registro y las pruebas del sintetizador.
 */
export function buildECGComplex(
  peakTimeMs: number,
  rrMs: number,
  rhythm: RhythmLabel,
  rScale = 1
): ECGComplex {
  const config = getRhythmConfig(rhythm);
  const { samples, durationMs, rPeakOffsetMs } = generateECGComplex(rrMs, config, { rScale });
  return {
    rPeakTime: peakTimeMs,
    rPeakOffsetMs,
    durationMs,
    rrMs,
    rhythm,
    rScale,
    hasP: config.hasPWave,
    isWideQrs: config.qrsWidthRatio > 1.2,
    samples,
  };
}
