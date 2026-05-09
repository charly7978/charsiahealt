/**
 * Streaming Catmull–Rom (cubic Hermite) resampler.
 *
 * Webcams deliver frames at irregular intervals (jitter, dropped frames, AGC
 * pauses). Downstream DSP — bandpass, FFT, peak detection — assumes a fixed
 * sample rate. This class accepts (timestampMs, value) pairs at arbitrary
 * cadence and emits values on a uniform grid (default 100 Hz) using a
 * 4-point Catmull–Rom spline. No allocations in the hot path.
 *
 * Fixed window of 4 control points (p0, p1, p2, p3); interpolated samples
 * land in the [p1, p2] segment with parameter t ∈ [0, 1).
 *
 * Reference: Catmull, Rom (1974). A class of local interpolating splines.
 */

export interface ResampledSample {
  readonly t: number;
  readonly value: number;
}

export class CubicSplineResampler {
  readonly periodMs: number;
  readonly sampleRate: number;

  // 4-point sliding window of control points.
  private t0 = 0; private v0 = 0;
  private t1 = 0; private v1 = 0;
  private t2 = 0; private v2 = 0;
  private t3 = 0; private v3 = 0;
  private filled = 0; // 0..4

  // Next output timestamp on the uniform grid.
  private nextOutT = Number.NaN;

  constructor(sampleRate: number = 100) {
    if (sampleRate <= 0) throw new Error("sampleRate must be > 0");
    this.sampleRate = sampleRate;
    this.periodMs = 1000 / sampleRate;
  }

  reset(): void {
    this.filled = 0;
    this.nextOutT = Number.NaN;
  }

  /**
   * Push a new (t, v) sample. Calls `emit(t, v)` for each uniform-grid
   * sample produced. Returns the number of emitted samples.
   *
   * `emit` MUST NOT retain references; values are transient.
   */
  push(t: number, v: number, emit: (t: number, v: number) => void): number {
    // Slide window.
    if (this.filled < 4) {
      switch (this.filled) {
        case 0: this.t0 = t; this.v0 = v; break;
        case 1: this.t1 = t; this.v1 = v; break;
        case 2: this.t2 = t; this.v2 = v; break;
        case 3: this.t3 = t; this.v3 = v; break;
      }
      this.filled++;
      if (this.filled === 4) {
        // Anchor uniform grid to first interior sample.
        this.nextOutT = this.t1;
      }
      return 0;
    }

    // Shift left, append new.
    this.t0 = this.t1; this.v0 = this.v1;
    this.t1 = this.t2; this.v1 = this.v2;
    this.t2 = this.t3; this.v2 = this.v3;
    this.t3 = t;       this.v3 = v;

    // Emit every uniform sample now resolvable in [t1, t2].
    let emitted = 0;
    const span = this.t2 - this.t1;
    if (span <= 0) return 0; // duplicate or out-of-order timestamp

    while (this.nextOutT <= this.t2) {
      if (this.nextOutT < this.t1) {
        // Catch-up after a long gap: snap forward.
        this.nextOutT = this.t1;
      }
      const u = (this.nextOutT - this.t1) / span;
      const out = catmullRom(this.v0, this.v1, this.v2, this.v3, u);
      emit(this.nextOutT, out);
      emitted++;
      this.nextOutT += this.periodMs;
      if (emitted > 10_000) break; // safety
    }
    return emitted;
  }
}

/**
 * Catmull–Rom basis with tension = 0.5 (centripetal-like, uniform spacing).
 * u ∈ [0, 1] interpolates between p1 and p2.
 */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * u +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * u3
  );
}
