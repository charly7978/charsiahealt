/**
 * Regression test for HeartBeatProcessor.
 *
 * Drives the processor with a deterministic synthetic PPG-like signal and
 * snapshots key numeric outputs (smoothBPM, sqi, rrIntervals, derivative tail).
 *
 * This test exists to lock numerical behavior BEFORE migrating internal
 * buffers to Float32Array-backed ring buffers. Any refactor that changes the
 * algorithm output will break this test.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { HeartBeatProcessor } from "../HeartBeatProcessor";

// Block AudioContext setup in JSDOM so the constructor doesn't throw.
beforeEach(() => {
  (window as any).AudioContext = undefined;
  (window as any).webkitAudioContext = undefined;
  vi.spyOn(document, "addEventListener").mockImplementation(() => {});
});

function syntheticBeat(t: number, bpm: number): number {
  // Composite waveform: dominant cardiac sinus + slight 2nd harmonic + slow drift.
  const f = bpm / 60; // Hz
  const phase = 2 * Math.PI * f * t;
  return (
    8 * Math.sin(phase) +
    2.5 * Math.sin(2 * phase + 0.4) +
    0.6 * Math.sin(0.15 * 2 * Math.PI * t)
  );
}

function runProcessor(bpm: number, durationS: number, fps: number) {
  const proc = new HeartBeatProcessor();
  const dt = 1000 / fps;
  let isPeakCount = 0;
  let lastResult: ReturnType<HeartBeatProcessor["processSignal"]> | null = null;
  for (let i = 0; i < durationS * fps; i++) {
    const t = i / fps;
    const ts = i * dt; // monotonic timestamp ms
    const v = syntheticBeat(t, bpm);
    const r = proc.processSignal(v, ts);
    if (r.isPeak) isPeakCount++;
    lastResult = r;
  }
  return { proc, lastResult: lastResult!, isPeakCount };
}

describe("HeartBeatProcessor regression baseline", () => {
  it("produces stable output snapshot for a 72 BPM sinusoid @ 30 fps / 12 s", () => {
    const { proc, lastResult, isPeakCount } = runProcessor(72, 12, 30);
    const rr = proc.getRRIntervals();
    const sqi = proc.getSQI();

    // Snapshot — these literals are baselines locked from current behavior.
    // After internal refactor they MUST remain identical (within 1e-6).
    expect({
      bpm: +lastResult.bpm.toFixed(4),
      sqi: +sqi.toFixed(4),
      isPeakCount,
      rrLen: rr.length,
      rrFirst: rr.length ? +rr[0].toFixed(4) : null,
      rrLast: rr.length ? +rr[rr.length - 1].toFixed(4) : null,
      derivTail: proc
        .getDerivativeBuffer()
        .slice(-3)
        .map((v) => +v.toFixed(6)),
    }).toMatchSnapshot();
  });

  it("produces stable output snapshot for a 95 BPM sinusoid @ 30 fps / 10 s", () => {
    const { proc, lastResult, isPeakCount } = runProcessor(95, 10, 30);
    const rr = proc.getRRIntervals();
    const sqi = proc.getSQI();

    expect({
      bpm: +lastResult.bpm.toFixed(4),
      sqi: +sqi.toFixed(4),
      isPeakCount,
      rrLen: rr.length,
      rrFirst: rr.length ? +rr[0].toFixed(4) : null,
      rrLast: rr.length ? +rr[rr.length - 1].toFixed(4) : null,
    }).toMatchSnapshot();
  });

  it("returns 0 BPM on flat signal (no false readings)", () => {
    const proc = new HeartBeatProcessor();
    let last: any = null;
    for (let i = 0; i < 300; i++) {
      last = proc.processSignal(0.0, i * 33.33);
    }
    expect(last.bpm).toBe(0);
    expect(last.isPeak).toBe(false);
  });
});
