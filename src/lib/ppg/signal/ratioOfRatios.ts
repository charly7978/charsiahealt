/**
 * Ratio-of-Ratios (RoR) estimator for experimental SpO2 from camera PPG.
 *
 * Classical pulse-oximetry uses two wavelengths (red ~660nm, IR ~940nm).
 * With a phone camera + flash we approximate by treating R and G channels
 * as a two-band proxy. This is RESEARCH-grade only, not clinical.
 *
 *   RoR = (AC_R / DC_R) / (AC_G / DC_G)
 *   SpO2 ≈ A − B · RoR     (generic linear empirical fit)
 *
 * AC is estimated as a windowed standard deviation; DC as an EMA of the
 * mean. Both run at the worker's resampled (fixed) rate, so the time
 * window in seconds is stable regardless of camera jitter.
 *
 * Output is gated by minimum DC, minimum AC and reasonable RoR range; on
 * gating failure the estimator returns `null` rather than fabricate a
 * value.
 */

export interface RoRReading {
  readonly ror: number;
  readonly acR: number;
  readonly dcR: number;
  readonly acG: number;
  readonly dcG: number;
  /** Experimental SpO2 in %. */
  readonly spo2: number;
}

export interface RoRConfig {
  /** Fixed sample rate of the input stream (Hz). Must match the resampler. */
  readonly sampleRate: number;
  /** Sliding window length in seconds for AC estimation. */
  readonly windowSeconds: number;
  /** EMA time constant (s) for DC tracking. */
  readonly dcTauSeconds: number;
  /** Linear calibration: SpO2 = a − b · RoR. */
  readonly calibA: number;
  readonly calibB: number;
}

export const DEFAULT_ROR_CONFIG: RoRConfig = {
  sampleRate: 100,
  windowSeconds: 3,
  dcTauSeconds: 1.5,
  calibA: 110,
  calibB: 25,
};

/**
 * Streaming AC/DC tracker with no per-sample allocations.
 *
 * AC uses Welford-on-a-window via two ring buffers (sum, sumSq) for O(1)
 * variance updates regardless of window length.
 */
class ChannelAcDc {
  private readonly window: Float64Array;
  private readonly capacity: number;
  private head = 0;
  private filled = 0;
  private sum = 0;
  private sumSq = 0;
  private dc = 0;
  private dcInitialized = false;
  private readonly dcAlpha: number;

  constructor(windowSamples: number, dcAlpha: number) {
    this.capacity = Math.max(8, windowSamples | 0);
    this.window = new Float64Array(this.capacity);
    this.dcAlpha = dcAlpha;
  }

  push(x: number): void {
    if (!this.dcInitialized) {
      this.dc = x;
      this.dcInitialized = true;
    } else {
      this.dc = this.dc * (1 - this.dcAlpha) + x * this.dcAlpha;
    }
    if (this.filled < this.capacity) {
      this.window[this.head] = x;
      this.sum += x;
      this.sumSq += x * x;
      this.filled++;
    } else {
      const old = this.window[this.head];
      this.window[this.head] = x;
      this.sum += x - old;
      this.sumSq += x * x - old * old;
    }
    this.head = (this.head + 1) % this.capacity;
  }

  /** Standard deviation of the current window — used as AC magnitude. */
  ac(): number {
    if (this.filled < 4) return 0;
    const mean = this.sum / this.filled;
    const variance = Math.max(0, this.sumSq / this.filled - mean * mean);
    return Math.sqrt(variance);
  }

  dcValue(): number {
    return this.dc;
  }

  reset(): void {
    this.head = 0;
    this.filled = 0;
    this.sum = 0;
    this.sumSq = 0;
    this.dc = 0;
    this.dcInitialized = false;
    this.window.fill(0);
  }
}

export class RatioOfRatios {
  readonly config: RoRConfig;
  private readonly red: ChannelAcDc;
  private readonly green: ChannelAcDc;

  constructor(config: RoRConfig = DEFAULT_ROR_CONFIG) {
    this.config = config;
    const win = Math.round(config.windowSeconds * config.sampleRate);
    const dcAlpha = 1 - Math.exp(-1 / (config.dcTauSeconds * config.sampleRate));
    this.red = new ChannelAcDc(win, dcAlpha);
    this.green = new ChannelAcDc(win, dcAlpha);
  }

  push(r: number, g: number): void {
    this.red.push(r);
    this.green.push(g);
  }

  /** Returns the latest reading or `null` if the gates fail. */
  read(): RoRReading | null {
    const dcR = this.red.dcValue();
    const dcG = this.green.dcValue();
    const acR = this.red.ac();
    const acG = this.green.ac();

    // Hard gates: avoid divide-by-zero and obviously degenerate signals.
    if (dcR < 5 || dcG < 5) return null;
    if (acR < 0.1 || acG < 0.1) return null;

    const num = acR / dcR;
    const den = acG / dcG;
    if (!(den > 1e-6)) return null;

    const ror = num / den;
    if (!Number.isFinite(ror) || ror <= 0 || ror > 5) return null;

    const spo2 = this.config.calibA - this.config.calibB * ror;
    // Clamp at the boundary of the sensible reporting range; outside this
    // band the linear model is meaningless and we refuse to publish.
    if (spo2 < 70 || spo2 > 100) return null;

    return { ror, acR, dcR, acG, dcG, spo2 };
  }

  reset(): void {
    this.red.reset();
    this.green.reset();
  }
}
