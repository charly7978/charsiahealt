import { describe, it, expect } from "vitest";
import { CubicSplineResampler, catmullRom } from "@/lib/ppg/signal/cubicSplineResampler";
import { RatioOfRatios, DEFAULT_ROR_CONFIG } from "@/lib/ppg/signal/ratioOfRatios";

describe("CubicSplineResampler", () => {
  it("emits a uniform 100Hz grid from jittered input", () => {
    const r = new CubicSplineResampler(100);
    const out: Array<[number, number]> = [];
    // Feed a 1 Hz sine at jittered ~30 fps over 2 seconds.
    let tPrev = -1;
    for (let i = 0; i < 80; i++) {
      const t = i * (1000 / 30) + (i % 3) * 1.7; // jitter
      const v = Math.sin(2 * Math.PI * 1.0 * (t / 1000));
      r.push(t, v, (ot, ov) => out.push([ot, ov]));
      tPrev = t;
    }
    expect(out.length).toBeGreaterThan(150);
    // Adjacent timestamps should be exactly 10ms apart.
    for (let i = 1; i < out.length; i++) {
      expect(out[i][0] - out[i - 1][0]).toBeCloseTo(10, 6);
    }
    // Reconstructed samples must approximate the source sine well.
    for (const [t, v] of out.slice(20, -20)) {
      const ref = Math.sin(2 * Math.PI * 1.0 * (t / 1000));
      expect(Math.abs(v - ref)).toBeLessThan(0.05);
    }
    void tPrev;
  });

  it("catmullRom recovers control points at u=0 and u=1", () => {
    expect(catmullRom(0, 1, 2, 3, 0)).toBeCloseTo(1, 10);
    expect(catmullRom(0, 1, 2, 3, 1)).toBeCloseTo(2, 10);
  });
});

describe("RatioOfRatios", () => {
  it("returns null on flat (DC-only) input", () => {
    const r = new RatioOfRatios({ ...DEFAULT_ROR_CONFIG });
    for (let i = 0; i < 600; i++) r.push(120, 80);
    expect(r.read()).toBeNull();
  });

  it("produces a finite RoR and clamped SpO2 on a clean PPG-like signal", () => {
    const r = new RatioOfRatios({ ...DEFAULT_ROR_CONFIG });
    const fs = 100;
    // 75 BPM modulation: large AC on R, small on G → RoR ≈ 1.3 → SpO2 ≈ 77.
    for (let i = 0; i < fs * 4; i++) {
      const phase = 2 * Math.PI * 1.25 * (i / fs);
      const acR = 4.0 * Math.sin(phase);
      const acG = 2.0 * Math.sin(phase);
      r.push(120 + acR, 80 + acG);
    }
    const reading = r.read();
    expect(reading).not.toBeNull();
    expect(reading!.ror).toBeGreaterThan(0);
    expect(reading!.spo2).toBeGreaterThanOrEqual(70);
    expect(reading!.spo2).toBeLessThanOrEqual(100);
  });
});
