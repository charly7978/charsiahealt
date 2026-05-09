import { describe, it, expect } from 'vitest';
import { LivenessEvaluator } from '../LivenessEvaluator';

const FPS = 30;
const SECS = 5;
const N = FPS * SECS;

function feed(ev: LivenessEvaluator, gen: (i: number) => number) {
  for (let i = 0; i < N; i++) ev.pushFiltered(gen(i), FPS);
}

describe('LivenessEvaluator', () => {
  it('A — inert red object: tiny noise on flat DC ⇒ score≈0, INERT_DC/NO_PULSATILITY', () => {
    const ev = new LivenessEvaluator(SECS, FPS);
    // Bandpassed inert red => essentially zero. Add a hair of noise.
    feed(ev, () => (Math.random() - 0.5) * 0.02);
    // AC/DC essentially zero on red.
    const v = ev.evaluate(/*redAC*/ 0.05, /*redDC*/ 220, /*greenAC*/ 0.04, /*greenDC*/ 80);
    expect(v.score).toBeLessThan(0.36);
    expect(['INERT_DC', 'NO_PULSATILITY']).toContain(v.reason);
  });

  it('B — clean cardiac sinusoid (1.2 Hz, 72 BPM) ⇒ high score, OK', () => {
    const ev = new LivenessEvaluator(SECS, FPS);
    const f = 1.2;
    feed(ev, (i) => Math.sin(2 * Math.PI * f * (i / FPS)));
    // Realistic AC/DC for live finger.
    const v = ev.evaluate(/*redAC*/ 0.8, /*redDC*/ 180, /*greenAC*/ 0.4, /*greenDC*/ 90);
    expect(v.score).toBeGreaterThan(0.6);
    expect(v.reason).toBe('OK');
    expect(v.autocorrPeak).toBeGreaterThan(0.5);
  });

  it('C — pure slow drift (0.3 Hz, no cardiac content) ⇒ DRIFT_ONLY or NO_PERIODICITY', () => {
    const ev = new LivenessEvaluator(SECS, FPS);
    const f = 0.3;
    feed(ev, (i) => 2 * Math.sin(2 * Math.PI * f * (i / FPS)));
    const v = ev.evaluate(0.6, 200, 0.3, 100);
    expect(['DRIFT_ONLY', 'NO_PERIODICITY']).toContain(v.reason);
    expect(v.score).toBeLessThan(0.55);
  });

  it('warm-up: not enough samples ⇒ WARMING_UP, score 0', () => {
    const ev = new LivenessEvaluator(SECS, FPS);
    for (let i = 0; i < 10; i++) ev.pushFiltered(Math.sin(i), FPS);
    const v = ev.evaluate(0.8, 180, 0.4, 90);
    expect(v.reason).toBe('WARMING_UP');
    expect(v.score).toBe(0);
  });
});
