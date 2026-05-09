/**
 * PPG Web Worker.
 *
 * Receives RGB samples + real-time FPS from the main thread via Transferable
 * Float32Array buffers (zero-copy), runs PCA fusion + Butterworth bandpass +
 * SQI on its own thread, and posts back a snapshot — also as a Transferable.
 *
 * The main thread never blocks on signal math.
 */

import { PPG_CONFIG } from "../types";
import { BandpassBiquad } from "../signal/filters";
import { RingBuffer } from "../signal/ringBuffer";
import { RgbPcaFusion } from "../signal/signalFusion";
import { computeSqi, type SqiWeights } from "../signal/sqi";
import { CubicSplineResampler } from "../signal/cubicSplineResampler";
import { RatioOfRatios, DEFAULT_ROR_CONFIG } from "../signal/ratioOfRatios";

export interface WorkerInboundSample {
  readonly type: "sample";
  /** [r, g, b, fps] packed as Float32Array (transferred). */
  readonly payload: Float32Array;
}

export interface WorkerInboundReset {
  readonly type: "reset";
}

export interface WorkerInboundConfig {
  readonly type: "config";
  readonly sqi: SqiWeights;
}

export type WorkerInbound =
  | WorkerInboundSample
  | WorkerInboundReset
  | WorkerInboundConfig;

export interface WorkerOutboundSnapshot {
  readonly type: "snapshot";
  readonly filtered: Float32Array;
  readonly sqi: number;
  readonly perfusionIndex: number;
  readonly skewness: number;
  readonly kurtosis: number;
  readonly fpsActual: number;
  readonly samples: number;
  /** Smoothed mean R/G/B in [0..255], suitable as input to SpO2 / lipids heads. */
  readonly meanR: number;
  readonly meanG: number;
  readonly meanB: number;
  /** Current Green-channel DC estimate (used for absorbance-style metrics). */
  readonly dcEstimate: number;
  /** Total samples processed since worker init (or last reset). */
  readonly samplesProcessed: number;
  /** Effective rate of the resampled DSP stream (Hz). */
  readonly resampledRate: number;
  /** Total uniform-grid samples emitted by the cubic-spline resampler. */
  readonly resampledCount: number;
  /** Ratio-of-Ratios (R vs G). EXPERIMENTAL — null when gates fail. */
  readonly ror: number | null;
  /** Empirical SpO2 from RoR. EXPERIMENTAL — research-only, not clinical. */
  readonly spo2Experimental: number | null;
}

const ringCapacity = Math.max(
  64,
  Math.round(PPG_CONFIG.FPS_TARGET * PPG_CONFIG.RING_SECONDS),
);

const filtered = new RingBuffer(ringCapacity);
const fusion = new RgbPcaFusion(ringCapacity);
let bandpass = new BandpassBiquad(
  PPG_CONFIG.FPS_TARGET,
  PPG_CONFIG.BANDPASS.lowHz,
  PPG_CONFIG.BANDPASS.highHz,
);
let dcEstimate = 0;
let dcInitialized = false;
let snapshotBuffer = new Float32Array(ringCapacity);
let lastEmit = 0;
let sampleCount = 0;
// Smoothed RGB means (EMA in RGB space) for downstream vital estimators.
let meanR = 0;
let meanG = 0;
let meanB = 0;
const RGB_EMA_ALPHA = 0.15;
let sqiWeights: SqiWeights = {
  perfusionScale: 25,
  weightPerfusion: 0.55,
  weightSkewness: 0.25,
  weightKurtosis: 0.2,
};
const EMIT_INTERVAL_MS = 1000 / PPG_CONFIG.STATE_THROTTLE_HZ;

// --- Cubic-spline resampler (fixed 100 Hz) feeding the RoR estimator ----
// The bandpass / heartbeat path keeps running at the camera FPS to preserve
// numerical compatibility with HeartBeatProcessor; the resampled stream is a
// parallel DSP path used by RoR (and exposed for downstream FFT consumers).
const RESAMPLED_RATE = 100;
const splineR = new CubicSplineResampler(RESAMPLED_RATE);
const splineG = new CubicSplineResampler(RESAMPLED_RATE);
const ror = new RatioOfRatios({ ...DEFAULT_ROR_CONFIG, sampleRate: RESAMPLED_RATE });
let resampledCount = 0;
let lastRoR: number | null = null;
let lastSpo2: number | null = null;
// Scratch holders so the resampler emit callback never closes over allocs.
let lastResampledR = 0;
let lastResampledG = 0;
let pendingR = false;
let pendingG = false;

function onResampledR(_t: number, v: number): void {
  lastResampledR = v;
  pendingR = true;
}
function onResampledG(_t: number, v: number): void {
  lastResampledG = v;
  pendingG = true;
}

function handleSample(payload: Float32Array): void {
  const r = payload[0];
  const g = payload[1];
  const b = payload[2];
  const fps = payload[3];

  if (Number.isFinite(fps) && fps > 1) bandpass.setSampleRate(fps);

  const fused = fusion.pushAndProject(r, g, b);
  const dcSource = g; // Green channel is the standard PPG DC reference.
  sampleCount++;
  if (!dcInitialized) {
    dcEstimate = dcSource;
    meanR = r;
    meanG = g;
    meanB = b;
    dcInitialized = true;
  } else {
    // Fast convergence first second (~30 samples), then slow tracking.
    const dcAlpha = sampleCount < 30 ? 0.15 : 0.01;
    dcEstimate = dcEstimate * (1 - dcAlpha) + dcSource * dcAlpha;
    meanR = meanR * (1 - RGB_EMA_ALPHA) + r * RGB_EMA_ALPHA;
    meanG = meanG * (1 - RGB_EMA_ALPHA) + g * RGB_EMA_ALPHA;
    meanB = meanB * (1 - RGB_EMA_ALPHA) + b * RGB_EMA_ALPHA;
  }

  const filt = bandpass.process(fused.value);
  filtered.push(filt);

  const now = performance.now();
  if (now - lastEmit < EMIT_INTERVAL_MS) return;
  lastEmit = now;

  if (snapshotBuffer.length !== filtered.capacity) {
    snapshotBuffer = new Float32Array(filtered.capacity);
  }
  const samples = filtered.snapshot(snapshotBuffer);
  const sqi = computeSqi(snapshotBuffer, samples, dcEstimate, sqiWeights);

  // Hand ownership of the snapshot buffer to the main thread, then re-allocate.
  const out: WorkerOutboundSnapshot = {
    type: "snapshot",
    filtered: snapshotBuffer,
    sqi: sqi.sqi,
    perfusionIndex: sqi.perfusionIndex,
    skewness: sqi.skewness,
    kurtosis: sqi.kurtosis,
    fpsActual: fps,
    samples,
    meanR,
    meanG,
    meanB,
    dcEstimate,
    samplesProcessed: sampleCount,
  };
  (self as unknown as Worker).postMessage(out, [snapshotBuffer.buffer]);
  snapshotBuffer = new Float32Array(filtered.capacity);
}

function handleReset(): void {
  filtered.clear();
  fusion.reset();
  bandpass = new BandpassBiquad(
    PPG_CONFIG.FPS_TARGET,
    PPG_CONFIG.BANDPASS.lowHz,
    PPG_CONFIG.BANDPASS.highHz,
  );
  dcEstimate = 0;
  dcInitialized = false;
  lastEmit = 0;
  sampleCount = 0;
  meanR = 0;
  meanG = 0;
  meanB = 0;
}

self.addEventListener("message", (event: MessageEvent<WorkerInbound>) => {
  const msg = event.data;
  if (msg.type === "sample") handleSample(msg.payload);
  else if (msg.type === "reset") handleReset();
  else if (msg.type === "config") sqiWeights = msg.sqi;
});
