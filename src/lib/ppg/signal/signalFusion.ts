/**
 * Closed-form PCA on a 3x3 covariance matrix of (R, G, B) channels.
 *
 * Uses an **online Welford accumulator** (with exponential forgetting
 * factor) for mean + cross-products: O(1) per sample instead of O(N).
 * Eigen-decomposition uses Cardano + Gauss elimination — fast, no deps.
 * The principal eigenvector is cached for `PCA_CACHE_FRAMES` samples;
 * RGB covariance evolves slowly, so reusing axis projection between
 * recomputes saves >50% CPU in the worker.
 */

const EPS = 1e-12;
/** Frames between full eigen-decomposition. Reuse axis in between. */
const PCA_CACHE_FRAMES = 4;
/** Forgetting factor applied per sample once the window is filled. */
const FORGET_LAMBDA = 0.995;

export interface FusionResult {
  readonly value: number;
  readonly eigenvalue: number;
  readonly axis: Readonly<[number, number, number]>;
}

function cardanoEigenvalues(
  m00: number,
  m11: number,
  m22: number,
  m01: number,
  m02: number,
  m12: number,
): [number, number, number] {
  const p2 = m00 + m11 + m22;
  const p1 =
    m00 * m11 + m00 * m22 + m11 * m22 - m01 * m01 - m02 * m02 - m12 * m12;
  const det =
    m00 * (m11 * m22 - m12 * m12) -
    m01 * (m01 * m22 - m12 * m02) +
    m02 * (m01 * m12 - m11 * m02);

  const a = -p2;
  const b = p1;
  const c = -det;
  const shift = -a / 3;
  const p = b - (a * a) / 3;
  const q = (2 * (a * a * a)) / 27 - (a * b) / 3 + c;
  const half = q / 2;
  const third = p / 3;
  const disc = half * half + third * third * third;

  if (disc > 0) {
    const sqrtDisc = Math.sqrt(disc);
    const u = Math.cbrt(-half + sqrtDisc);
    const v = Math.cbrt(-half - sqrtDisc);
    const root = u + v + shift;
    return [root, root, root];
  }

  const r = Math.sqrt(-third * third * third);
  const phi = Math.acos(Math.max(-1, Math.min(1, -half / Math.max(r, EPS))));
  const m = 2 * Math.cbrt(r);
  const t1 = m * Math.cos(phi / 3);
  const t2 = m * Math.cos((phi + 2 * Math.PI) / 3);
  const t3 = m * Math.cos((phi + 4 * Math.PI) / 3);
  return [t1 + shift, t2 + shift, t3 + shift];
}

function principalEigenvector(
  m00: number,
  m11: number,
  m22: number,
  m01: number,
  m02: number,
  m12: number,
  lambda: number,
): [number, number, number] {
  const a = m00 - lambda;
  const d = m11 - lambda;
  const f = m22 - lambda;

  const r0x = a;
  const r0y = m01;
  const r0z = m02;
  const r1x = m01;
  const r1y = d;
  const r1z = m12;
  const r2x = m02;
  const r2y = m12;
  const r2z = f;

  const candidates: Array<[number, number, number]> = [
    [r0y * r1z - r0z * r1y, r0z * r1x - r0x * r1z, r0x * r1y - r0y * r1x],
    [r0y * r2z - r0z * r2y, r0z * r2x - r0x * r2z, r0x * r2y - r0y * r2x],
    [r1y * r2z - r1z * r2y, r1z * r2x - r1x * r2z, r1x * r2y - r1y * r2x],
  ];

  let best: [number, number, number] = [0, 1, 0];
  let bestNorm = 0;
  for (let i = 0; i < candidates.length; i++) {
    const v = candidates[i];
    const n = Math.hypot(v[0], v[1], v[2]);
    if (n > bestNorm) {
      bestNorm = n;
      best = v;
    }
  }
  if (bestNorm < EPS) return [0, 1, 0];
  return [best[0] / bestNorm, best[1] / bestNorm, best[2] / bestNorm];
}

/** Online RGB-channel PCA with Welford + forgetting factor. */
export class RgbPcaFusion {
  private readonly windowSamples: number;
  // Welford state.
  private n = 0;
  private mr = 0;
  private mg = 0;
  private mb = 0;
  private M2_rr = 0;
  private M2_gg = 0;
  private M2_bb = 0;
  private M2_rg = 0;
  private M2_rb = 0;
  private M2_gb = 0;

  // Cached axis (recomputed every PCA_CACHE_FRAMES samples).
  private cachedAxis: [number, number, number] | null = null;
  private cachedEigenvalue = 0;
  private framesSinceRefresh = 0;

  constructor(windowSamples: number) {
    this.windowSamples = Math.max(8, windowSamples);
  }

  pushAndProject(r: number, g: number, b: number): FusionResult {
    // Apply forgetting factor once we exceed the nominal window — keeps
    // the accumulator adaptive without storing all past samples.
    if (this.n >= this.windowSamples) {
      this.n *= FORGET_LAMBDA;
      this.M2_rr *= FORGET_LAMBDA;
      this.M2_gg *= FORGET_LAMBDA;
      this.M2_bb *= FORGET_LAMBDA;
      this.M2_rg *= FORGET_LAMBDA;
      this.M2_rb *= FORGET_LAMBDA;
      this.M2_gb *= FORGET_LAMBDA;
    }

    this.n += 1;
    const drOld = r - this.mr;
    const dgOld = g - this.mg;
    const dbOld = b - this.mb;
    const inv = 1 / this.n;
    this.mr += drOld * inv;
    this.mg += dgOld * inv;
    this.mb += dbOld * inv;
    const drNew = r - this.mr;
    const dgNew = g - this.mg;
    const dbNew = b - this.mb;
    this.M2_rr += drOld * drNew;
    this.M2_gg += dgOld * dgNew;
    this.M2_bb += dbOld * dbNew;
    this.M2_rg += drOld * dgNew;
    this.M2_rb += drOld * dbNew;
    this.M2_gb += dgOld * dbNew;

    if (this.n < 8) {
      return {
        value: g,
        eigenvalue: 0,
        axis: [0, 1, 0],
      };
    }

    // Recompute axis only every PCA_CACHE_FRAMES samples.
    this.framesSinceRefresh++;
    if (this.cachedAxis === null || this.framesSinceRefresh >= PCA_CACHE_FRAMES) {
      this.framesSinceRefresh = 0;
      const denom = Math.max(1, this.n - 1);
      const crr = this.M2_rr / denom;
      const cgg = this.M2_gg / denom;
      const cbb = this.M2_bb / denom;
      const crg = this.M2_rg / denom;
      const crb = this.M2_rb / denom;
      const cgb = this.M2_gb / denom;

      const eigs = cardanoEigenvalues(crr, cgg, cbb, crg, crb, cgb);
      let lambda = eigs[0];
      if (eigs[1] > lambda) lambda = eigs[1];
      if (eigs[2] > lambda) lambda = eigs[2];
      const axis = principalEigenvector(crr, cgg, cbb, crg, crb, cgb, lambda);
      const sign = axis[1] < 0 ? -1 : 1;
      this.cachedAxis = [axis[0] * sign, axis[1] * sign, axis[2] * sign];
      this.cachedEigenvalue = lambda;
    }

    const axis = this.cachedAxis;
    const value =
      axis[0] * (r - this.mr) +
      axis[1] * (g - this.mg) +
      axis[2] * (b - this.mb);
    return { value, eigenvalue: this.cachedEigenvalue, axis };
  }

  reset(): void {
    this.n = 0;
    this.mr = 0;
    this.mg = 0;
    this.mb = 0;
    this.M2_rr = 0;
    this.M2_gg = 0;
    this.M2_bb = 0;
    this.M2_rg = 0;
    this.M2_rb = 0;
    this.M2_gb = 0;
    this.cachedAxis = null;
    this.cachedEigenvalue = 0;
    this.framesSinceRefresh = 0;
  }
}
