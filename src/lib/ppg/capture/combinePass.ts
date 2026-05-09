/**
 * Single-pass RGBA scan that simultaneously feeds:
 *   - the global finger detector (mean RGB, clip ratios, dominance)
 *   - the AdaptiveRoi tile accumulators (per-tile RGB sums + per-tile
 *     clip/dark counts for the score function)
 *
 * Two iterations over a 160x120 RGBA buffer == ~38k pixel reads each. By
 * fusing them we halve the bandwidth on the hot path and avoid double
 * cache traffic, which is the single largest cost of the capture loop on
 * mid-range Android.
 */

import type { AdaptiveRoi, RoiResult } from "../roi/adaptiveRoi";
import type {
  FingerDetectionResult,
  FingerDetectionThresholds,
} from "../detection/fingerDetector";

const SAT_HIGH_ROI = 252;
const DARK_LUMA_ROI = 20;

/** Internal numeric scratch buffers, re-allocated only when grid size changes. */
class TileScratch {
  cols = 0;
  rows = 0;
  sumR!: Float32Array;
  sumG!: Float32Array;
  sumB!: Float32Array;
  valid!: Uint32Array;
  clip!: Uint32Array;
  dark!: Uint32Array;
  total!: Uint32Array;

  ensure(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) {
      this.sumR.fill(0);
      this.sumG.fill(0);
      this.sumB.fill(0);
      this.valid.fill(0);
      this.clip.fill(0);
      this.dark.fill(0);
      this.total.fill(0);
      return;
    }
    const n = cols * rows;
    this.cols = cols;
    this.rows = rows;
    this.sumR = new Float32Array(n);
    this.sumG = new Float32Array(n);
    this.sumB = new Float32Array(n);
    this.valid = new Uint32Array(n);
    this.clip = new Uint32Array(n);
    this.dark = new Uint32Array(n);
    this.total = new Uint32Array(n);
  }
}

const SCRATCH = new TileScratch();

export interface CombinedPassResult {
  readonly detection: FingerDetectionResult;
  readonly aggregate: RoiResult;
}

export function classifyAndAggregate(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  thresholds: FingerDetectionThresholds,
  roi: AdaptiveRoi,
): CombinedPassResult {
  const cols = roi.cols;
  const rows = roi.rows;
  SCRATCH.ensure(cols, rows);

  const tileW = Math.max(1, (width / cols) | 0);
  const tileH = Math.max(1, (height / rows) | 0);

  // Finger-detector accumulators.
  const SAT_HIGH = thresholds.saturationHigh;
  const DARK_LUMA = thresholds.darkLuma;
  const RED_DOMINANCE = thresholds.redDominance;
  const COVERAGE_THRESHOLD = thresholds.coverage;

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let validCount = 0;
  let clipHigh = 0;
  let clipLow = 0;
  let pixelCount = 0;

  const stride = width * 4;

  for (let y = 0; y < height; y++) {
    let p = y * stride;
    let ty = (y / tileH) | 0;
    if (ty >= rows) ty = rows - 1;
    const tileRowOffset = ty * cols;

    for (let x = 0; x < width; x++) {
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      p += 4;

      let tx = (x / tileW) | 0;
      if (tx >= cols) tx = cols - 1;
      const ti = tileRowOffset + tx;

      const luma = (r * 299 + g * 587 + b * 114) * 0.001;
      pixelCount++;
      SCRATCH.total[ti]++;

      // === ROI-side accumulation (uses ROI thresholds 252/20) ===
      const roiClipped = r >= SAT_HIGH_ROI && g >= SAT_HIGH_ROI && b >= SAT_HIGH_ROI;
      const roiDark = luma <= DARK_LUMA_ROI;
      if (roiClipped) {
        SCRATCH.clip[ti]++;
      } else if (roiDark) {
        SCRATCH.dark[ti]++;
      } else {
        SCRATCH.valid[ti]++;
        SCRATCH.sumR[ti] += r;
        SCRATCH.sumG[ti] += g;
        SCRATCH.sumB[ti] += b;
      }

      // === Finger-detector side (uses caller-provided thresholds) ===
      if (r >= SAT_HIGH && g >= SAT_HIGH && b >= SAT_HIGH) {
        clipHigh++;
        continue;
      }
      if (luma <= DARK_LUMA) {
        clipLow++;
        continue;
      }
      const dominance = r - (g + b) * 0.5;
      if (dominance >= RED_DOMINANCE) {
        validCount++;
        sumR += r;
        sumG += g;
        sumB += b;
      }
    }
  }

  // Finalize finger detection result.
  const coverage = pixelCount > 0 ? validCount / pixelCount : 0;
  const meanR = validCount > 0 ? sumR / validCount : 0;
  const meanG = validCount > 0 ? sumG / validCount : 0;
  const meanB = validCount > 0 ? sumB / validCount : 0;
  const clipHighRatio = pixelCount > 0 ? clipHigh / pixelCount : 0;
  const clipLowRatio = pixelCount > 0 ? clipLow / pixelCount : 0;
  const score = coverage * (1 - clipHighRatio * 0.8) * (1 - clipLowRatio * 0.5);
  const fingerDetected =
    coverage >= COVERAGE_THRESHOLD &&
    clipHighRatio < 0.35 &&
    meanR > meanG &&
    meanR > meanB;

  const detection: FingerDetectionResult = {
    fingerDetected,
    score,
    meanR,
    meanG,
    meanB,
    clipHigh: clipHighRatio,
    clipLow: clipLowRatio,
  };

  // Hand the pre-computed tile aggregates to the ROI, which finishes the
  // EMA smoothing + normalization step.
  const aggregate = roi.finalizeFromSums(
    SCRATCH.sumR,
    SCRATCH.sumG,
    SCRATCH.sumB,
    SCRATCH.valid,
    SCRATCH.clip,
    SCRATCH.dark,
    SCRATCH.total,
  );

  return { detection, aggregate };
}
