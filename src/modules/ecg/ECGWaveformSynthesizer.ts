import {
  buildECGComplex,
  evaluateECGComplex,
  getRhythmConfig,
} from './ECGComplexModel';
import type {
  ECGComplex,
  ECGValuePoint,
  ECGWaveformSynthesizerConfig,
  RhythmLabel,
} from './types';

const DEFAULT_CONFIG: Required<ECGWaveformSynthesizerConfig> = {
  sampleRateHz: 60,
  bufferSize: 24,
  refractoryMs: 250,
  rScaleBase: 1,
};

/** Máx. puntos en el buffer de salida (≈ 6.7 s a 60 Hz). */
const MAX_BUFFER_POINTS = 400;

/**
 * Sintetizador continuo de ECG con realineado de fase.
 *
 * Cada latido real (pico R detectado) define el inicio del complejo P-QRS-T
 * en el pasado: `start = peakTime - rPeakOffset`. Al llegar un latido nuevo
 * el buffer muestreado se recorta a ese instante y se regenera, de modo que
 * la onda P y el QRS aparecen ANTES del pico R (fisiología correcta) y el
 * complejo queda anclado 1:1 al intervalo RR real.
 *
 * El hot path (`sample`) evalúa los complejos con `evaluateECGComplex`
 * (función pura, sin asignaciones por punto).
 */
export class ECGWaveformSynthesizer {
  private readonly config: Required<ECGWaveformSynthesizerConfig>;

  /** Complejos activos ordenados por tiempo de pico R (FIFO). */
  private complexes: ECGComplex[] = [];

  /** Buffer continuo de salida (ya emitido). */
  private buffer: ECGValuePoint[] = [];

  /** Último instante muestreado (ms). */
  private lastSampleTimeMs = -Infinity;

  /** Último pico R aceptado (refractario). */
  private lastBeatTimeMs = -Infinity;

  /** Paso de muestreo en ms (derivado de sampleRateHz). */
  private readonly stepMs: number;

  constructor(config?: ECGWaveformSynthesizerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stepMs = 1000 / this.config.sampleRateHz;
    this.reset();
  }

  /** Alimenta un latido real detectado. Devuelve el complejo generado o null si se ignora (refractario). */
  onHeartBeat(peakTimeMs: number, rrMs: number, rhythm: RhythmLabel): ECGComplex | null {
    if (peakTimeMs - this.lastBeatTimeMs < this.config.refractoryMs) {
      return null;
    }
    this.lastBeatTimeMs = peakTimeMs;

    const complex = buildECGComplex(peakTimeMs, rrMs, rhythm);
    this.complexes.push(complex);
    if (this.complexes.length > this.config.bufferSize) {
      this.complexes.shift();
    }

    // Realinear: el complejo empezó en el pasado → recortar puntos ya emitidos
    // que caen dentro del complejo y regenerarlos (P + QRS quedan antes de R).
    const complexStart = peakTimeMs - complex.rPeakOffsetMs;
    if (this.buffer.length > 0 && complexStart < this.lastSampleTimeMs) {
      let cut = this.buffer.length;
      while (cut > 0 && this.buffer[cut - 1].time >= complexStart) cut--;
      this.buffer.length = cut;
      this.lastSampleTimeMs =
        cut > 0 ? this.buffer[cut - 1].time : complexStart - this.stepMs;
    }

    return complex;
  }

  /** Rellena el buffer continuo hasta `untilTimeMs` y devuelve los puntos nuevos. */
  sample(untilTimeMs: number): ECGValuePoint[] {
    const points: ECGValuePoint[] = [];
    if (untilTimeMs <= this.lastSampleTimeMs) return points;

    const stepMs = this.stepMs;

    let t: number;
    if (this.lastSampleTimeMs === -Infinity) {
      // Primer muestreo: arranca desde el inicio del complejo más antiguo
      // (si existe) para que la onda P quede dentro de la ventana.
      const earliestStart = this.complexes.reduce(
        (min, c) => Math.min(min, c.rPeakTime - c.rPeakOffsetMs),
        Infinity
      );
      t = Number.isFinite(earliestStart) ? earliestStart : untilTimeMs;
    } else {
      t = this.lastSampleTimeMs + stepMs;
    }

    while (t <= untilTimeMs) {
      // Snap al pico R: si un complejo activo tiene su pico dentro del próximo
      // paso de muestreo, emitimos la muestra exacta del pico (isPeak=true,
      // y = R). Garantiza la marca de latido aunque el grid no esté alineado.
      let snapTime: number | null = null;
      for (const complex of this.complexes) {
        if (complex.rPeakTime > t && complex.rPeakTime <= t + stepMs) {
          snapTime = complex.rPeakTime;
          break;
        }
      }
      points.push(this.sampleAt(snapTime !== null ? snapTime : t));
      t += stepMs;
    }

    this.lastSampleTimeMs = t - stepMs;

    if (points.length > 0) {
      for (const p of points) this.buffer.push(p);
      if (this.buffer.length > MAX_BUFFER_POINTS) {
        this.buffer.splice(0, this.buffer.length - MAX_BUFFER_POINTS);
      }
    }

    return points;
  }

  /** Evalúa el valor ECG + flags en un instante dado (superpone complejos activos). */
  private sampleAt(timeMs: number): ECGValuePoint {
    let y = 0;
    let isPeak = false;
    let isArrhythmia = false;
    let rhythm: RhythmLabel = 'NSR';
    let activeRhythm: RhythmLabel | null = null;

    for (let i = this.complexes.length - 1; i >= 0; i--) {
      const complex = this.complexes[i];
      const complexStart = complex.rPeakTime - complex.rPeakOffsetMs;
      const localT = timeMs - complexStart;

      // Solo dentro del complejo contribuye (fuera = pausa TP isoeléctrica).
      if (localT < 0 || localT > complex.durationMs) continue;

      // El complejo más reciente con contribución define el ritmo del tramo.
      if (activeRhythm === null) activeRhythm = complex.rhythm;

      const config = getRhythmConfig(complex.rhythm);
      y += evaluateECGComplex(localT, complex.rrMs, config, complex.rScale);

      if (Math.abs(localT - complex.rPeakOffsetMs) < 1) {
        isPeak = true;
      }
    }

    if (activeRhythm !== null) {
      rhythm = activeRhythm;
      isArrhythmia =
        activeRhythm !== 'NSR' && activeRhythm !== 'TACHY' && activeRhythm !== 'BRADY';
    }

    return { time: timeMs, y, isPeak, rhythm, isArrhythmia };
  }

  /** Puntos acumulados en el buffer (para inspección / pruebas). */
  getBufferedPoints(): ECGValuePoint[] {
    return this.buffer.slice();
  }

  /** Reinicia el estado interno (cola, buffer, timestamps). */
  reset(): void {
    this.complexes = [];
    this.buffer = [];
    this.lastSampleTimeMs = -Infinity;
    this.lastBeatTimeMs = -Infinity;
  }
}
