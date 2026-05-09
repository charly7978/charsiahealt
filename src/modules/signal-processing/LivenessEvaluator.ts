/**
 * Liveness evaluator — discriminates a real human finger PPG signal from
 * inert red objects, paint, or static surfaces.
 *
 * Multi-evidence: AC/DC perfusion, normalized AC variance, autocorrelation
 * peak in cardiac band, drift-vs-cardiac power ratio, and IBI variability.
 *
 * Zero-allocation hot path: uses a Float64Array ring for the filtered signal.
 */

export type LivenessReason =
  | 'OK'
  | 'WARMING_UP'
  | 'INERT_DC'
  | 'NO_PULSATILITY'
  | 'NO_PERIODICITY'
  | 'DRIFT_ONLY'
  | 'CONSTANT_IBI';

export interface LivenessVerdict {
  readonly score: number;     // 0..1
  readonly reason: LivenessReason;
  readonly acdcRed: number;
  readonly acdcGreen: number;
  readonly autocorrPeak: number;
  readonly autocorrLag: number;
  readonly cardiacToDriftRatio: number;
}

export class LivenessEvaluator {
  private readonly capacity: number;
  private readonly buf: Float64Array;
  private head = 0;
  private size = 0;

  // Cached metrics (updated on evaluate()).
  private fps = 30;

  constructor(seconds = 5, baseFps = 30) {
    this.capacity = Math.max(64, Math.round(seconds * baseFps));
    this.buf = new Float64Array(this.capacity);
  }

  reset(): void {
    this.head = 0;
    this.size = 0;
    for (let i = 0; i < this.capacity; i++) this.buf[i] = 0;
  }

  pushFiltered(value: number, fps: number): void {
    if (Number.isFinite(fps) && fps > 5 && fps < 90) this.fps = fps;
    if (!Number.isFinite(value)) return;
    this.buf[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /**
   * Evaluate liveness given upstream channel AC/DC and (optional) recent IBIs.
   *
   * @param redAC  Pulsatile amplitude on red channel (raw units).
   * @param redDC  DC level on red channel (raw units).
   * @param greenAC Pulsatile amplitude on green channel (raw units).
   * @param greenDC DC level on green channel (raw units).
   * @param recentIbisMs Optional IBIs to validate variability.
   */
  evaluate(
    redAC: number,
    redDC: number,
    greenAC: number,
    greenDC: number,
    recentIbisMs?: ReadonlyArray<number>,
  ): LivenessVerdict {
    const minSamples = Math.round(this.fps * 2.5); // need ≥2.5s to judge.
    if (this.size < minSamples) {
      return {
        score: 0,
        reason: 'WARMING_UP',
        acdcRed: 0,
        acdcGreen: 0,
        autocorrPeak: 0,
        autocorrLag: 0,
        cardiacToDriftRatio: 0,
      };
    }

    const acdcRed = redDC > 1 ? redAC / redDC : 0;
    const acdcGreen = greenDC > 1 ? greenAC / greenDC : 0;

    // --- 1. Inert DC check: perfusion must exceed camera-noise floor.
    // Red plastic + flash typical AC/DC ≈ 0.0003; live finger ≥ 0.002.
    const perfusionOk = acdcRed >= 0.0015 || acdcGreen >= 0.0010;

    // --- 2. Normalized variance of bandpassed signal.
    let mean = 0;
    for (let i = 0; i < this.size; i++) mean += this.readAt(i);
    mean /= this.size;

    let variance = 0;
    for (let i = 0; i < this.size; i++) {
      const d = this.readAt(i) - mean;
      variance += d * d;
    }
    variance /= this.size;
    const std = Math.sqrt(variance);

    // --- 3. Autocorrelation in cardiac band (40..200 BPM).
    const minLag = Math.max(3, Math.floor(this.fps * 60 / 200));
    const maxLag = Math.min(this.size - 4, Math.floor(this.fps * 60 / 40));

    let bestLag = 0;
    let bestPeak = 0;
    const denom = variance * this.size;
    if (denom > 1e-9) {
      for (let lag = minLag; lag <= maxLag; lag++) {
        let acc = 0;
        for (let i = 0; i < this.size - lag; i++) {
          acc += (this.readAt(i) - mean) * (this.readAt(i + lag) - mean);
        }
        const r = acc / denom;
        if (r > bestPeak) {
          bestPeak = r;
          bestLag = lag;
        }
      }
    }

    // --- 4. Drift-vs-cardiac power ratio (cheap proxy: low-pass diff vs total).
    // Compute power of moving-average residual to estimate "drift".
    const win = Math.min(this.size, Math.round(this.fps * 1.2));
    let driftPow = 0;
    if (win >= 4) {
      // Simple boxcar smoothing (low-pass ~0.4 Hz at fps=30) → drift estimate.
      let sum = 0;
      for (let i = 0; i < win; i++) sum += this.readAt(i);
      let prevAvg = sum / win;
      for (let i = win; i < this.size; i++) {
        sum += this.readAt(i) - this.readAt(i - win);
        const avg = sum / win;
        driftPow += avg * avg;
        prevAvg = avg;
      }
      driftPow /= Math.max(1, this.size - win);
    }
    const cardiacPow = Math.max(0, variance - driftPow);
    const cardiacToDriftRatio = driftPow > 1e-9 ? cardiacPow / driftPow : (cardiacPow > 0 ? 5 : 0);

    // --- 5. IBI variability check (constant = synthetic).
    let ibiOk = true;
    if (recentIbisMs && recentIbisMs.length >= 4) {
      let m = 0;
      for (const v of recentIbisMs) m += v;
      m /= recentIbisMs.length;
      let v = 0;
      for (const x of recentIbisMs) v += (x - m) * (x - m);
      v /= recentIbisMs.length;
      const cv = m > 0 ? Math.sqrt(v) / m : 0;
      // Healthy CV typically 0.01..0.20; allow up to 0.40.
      ibiOk = cv > 0.005 && cv < 0.45;
    }

    // --- Decide reason (most diagnostic first).
    let reason: LivenessReason = 'OK';
    if (!perfusionOk && std < 0.1) reason = 'INERT_DC';
    else if (!perfusionOk) reason = 'NO_PULSATILITY';
    else if (bestPeak < 0.30) reason = 'NO_PERIODICITY';
    else if (cardiacToDriftRatio < 0.5) reason = 'DRIFT_ONLY';
    else if (!ibiOk) reason = 'CONSTANT_IBI';

    // --- Score: 5 components with weights.
    const sPerf = clamp01((Math.max(acdcRed, acdcGreen * 1.5) - 0.0008) / 0.004);
    const sPeriod = clamp01((bestPeak - 0.20) / 0.45);
    const sCardiac = clamp01((cardiacToDriftRatio - 0.3) / 1.2);
    const sIbi = ibiOk ? 1 : 0;
    const sVar = clamp01((std - 0.05) / 0.5);

    let score = 0.30 * sPerf + 0.30 * sPeriod + 0.20 * sCardiac + 0.10 * sIbi + 0.10 * sVar;
    if (reason !== 'OK') score = Math.min(score, 0.35);

    return {
      score: clamp01(score),
      reason,
      acdcRed,
      acdcGreen,
      autocorrPeak: bestPeak,
      autocorrLag: bestLag,
      cardiacToDriftRatio,
    };
  }

  private readAt(i: number): number {
    // i=0 → oldest sample, i=size-1 → newest.
    const start = (this.head - this.size + this.capacity) % this.capacity;
    return this.buf[(start + i) % this.capacity];
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
