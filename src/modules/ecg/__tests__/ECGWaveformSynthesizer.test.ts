import { describe, it, expect, beforeEach } from 'vitest';
import { generateECGComplex, rhythmFromStatus, rhythmConfig } from '../ECGComplexModel';

describe('ECGComplexModel', () => {
  it('generates a complex with P-QRS-T for NSR with valid samples', () => {
    const result = generateECGComplex(800, rhythmConfig('NSR'), { sampleRateHz: 60 });
    expect(result.samples.length).toBeGreaterThan(30);
    expect(result.durationMs).toBeGreaterThan(0);
    const hasR = result.samples.some((s) => s.y > 0.8);
    expect(hasR).toBe(true);
  });

  it('detects rhythm from status and bpm', () => {
    expect(rhythmFromStatus('AF DETECTADA|1', 80, [800])).toBe('AF');
    expect(rhythmFromStatus('PVC DETECTADO|1', 80, [800])).toBe('PVC');
    expect(rhythmFromStatus(undefined, 110, [])).toBe('TACHY');
    expect(rhythmFromStatus(undefined, 55, [])).toBe('BRADY');
  });
});