import { describe, it, expect } from 'vitest';
import {
  generateECGComplex,
  evaluateECGComplex,
  rhythmFromStatus,
  buildECGComplex,
  getRhythmConfig,
} from '../ECGComplexModel';
import { ECGWaveformSynthesizer } from '../ECGWaveformSynthesizer';
import type { ECGComplexConfig } from '../types';

describe('generateECGComplex', () => {
  it('genera complejo NSR con duración clamp(0.6 × RR, 420, 1050)', () => {
    expect(generateECGComplex(600).durationMs).toBe(420);
    expect(generateECGComplex(1000).durationMs).toBe(600);
    expect(generateECGComplex(5000).durationMs).toBe(1050);
    // RR inválido → fallback 800 ms.
    expect(generateECGComplex(0).durationMs).toBe(480);
  });

  it('picos de fase correctos para RR 600/800/1000 ms: P ~0.07, QRS ~0.23, T ~0.48', () => {
    for (const rr of [600, 800, 1000]) {
      const { samples, durationMs, rPeakOffsetMs } = generateECGComplex(rr, undefined, { seed: 42 });

      const windowPeak = (startFrac: number, endFrac: number) => {
        let best = { t: 0, y: -Infinity };
        for (const s of samples) {
          if (s.t >= startFrac * durationMs && s.t <= endFrac * durationMs && s.y > best.y) {
            best = s;
          }
        }
        return best;
      };

      const pPeak = windowPeak(0, 0.18);
      const rPeak = windowPeak(0.15, 0.32);
      const tPeak = windowPeak(0.35, 0.6);

      expect(pPeak.t / durationMs).toBeGreaterThan(0.02);
      expect(pPeak.t / durationMs).toBeLessThan(0.15);
      expect(rPeak.t / durationMs).toBeGreaterThan(0.18);
      expect(rPeak.t / durationMs).toBeLessThan(0.32);
      expect(tPeak.t / durationMs).toBeGreaterThan(0.35);
      expect(tPeak.t / durationMs).toBeLessThan(0.6);

      // La R es el máximo absoluto del complejo (muestra anclada en el pico).
      const globalMax = samples.reduce((m, s) => (s.y > m.y ? s : m), samples[0]);
      expect(globalMax.t).toBeCloseTo(rPeak.t, 0);
      expect(rPeakOffsetMs / durationMs).toBeGreaterThan(0.18);
      expect(rPeakOffsetMs / durationMs).toBeLessThan(0.32);
    }
  });
});

describe('morfología PVC / PAC', () => {
  const pvcConfig: ECGComplexConfig = {
    pAmplitude: 0,
    qAmplitude: -0.28,
    rAmplitude: 1.06,
    sAmplitude: -0.42,
    tAmplitude: -0.28,
    qrsWidthRatio: 1.4,
    hasPWave: false,
    stElevation: -0.03,
  };
  const pacConfig: ECGComplexConfig = {
    pAmplitude: 0.24,
    qAmplitude: -0.18,
    rAmplitude: 0.95,
    sAmplitude: -0.26,
    tAmplitude: 0.28,
    qrsWidthRatio: 0.8,
    hasPWave: true,
    stElevation: 0,
  };

  /** Anchura del QRS en ms medida por barrido fino con |y| > 0.45. */
  const qrsWidthMs = (rr: number, config: ECGComplexConfig): number => {
    const durationMs = generateECGComplex(rr).durationMs;
    const step = 1; // 1 ms
    let first = -1;
    let last = -1;
    for (let t = 0; t <= durationMs; t += step) {
      const y = evaluateECGComplex(t, rr, config);
      if (Math.abs(y) > 0.45) {
        if (first === -1) first = t;
        last = t;
      }
    }
    return last - first;
  };

  it('PVC: sin onda P, QRS ancho (ratio 1.4), S profunda', () => {
    const rr = 1000;
    const nsrWidth = qrsWidthMs(rr, getRhythmConfig('NSR'));
    const pvcWidth = qrsWidthMs(rr, pvcConfig);
    expect(pvcWidth).toBeGreaterThan(nsrWidth * 1.2);

    // Sin onda P: en la ventana P (0–0.14 × dur) la amplitud no supera 0.1.
    const durationMs = generateECGComplex(rr).durationMs;
    let maxP = 0;
    for (let t = 0; t < 0.14 * durationMs; t += 1) {
      maxP = Math.max(maxP, evaluateECGComplex(t, rr, pvcConfig));
    }
    expect(maxP).toBeLessThan(0.1);

    // S profunda y T invertida → hay muestra negativa < -0.35.
    const minY = Math.min(
      ...Array.from({ length: 200 }, (_, i) =>
        evaluateECGComplex((i / 199) * durationMs, rr, pvcConfig)
      )
    );
    expect(minY).toBeLessThan(-0.35);
  });

  it('PAC: QRS angosto (ratio 0.8)', () => {
    const rr = 1000;
    const nsrWidth = qrsWidthMs(rr, getRhythmConfig('NSR'));
    const pacWidth = qrsWidthMs(rr, pacConfig);
    expect(pacWidth).toBeLessThan(nsrWidth * 0.95);
  });
});

describe('rhythmFromStatus', () => {
  it('infiere PVC aislado desde el patrón RR (formato real SIN ARRITMIAS|0)', () => {
    // RR corto (520) tras RR largos (800): latido prematuro ventricular.
    expect(rhythmFromStatus('SIN ARRITMIAS|0', 75, [800, 800, 520])).toBe('PVC');
  });

  it('detecta AF por CV > 0.12 sostenido aunque el estado no lo diga', () => {
    const irregular = [820, 540, 910, 610, 780, 500, 860, 590, 790, 520];
    expect(rhythmFromStatus('ARRITMIA DETECTADA|3', 85, irregular)).toBe('AF');
    expect(rhythmFromStatus('SIN ARRITMIAS|0', 85, irregular)).toBe('AF');
  });

  it('distingue TACHY / BRADY / NSR por rango', () => {
    expect(rhythmFromStatus(undefined, 120, [500, 500, 500])).toBe('TACHY');
    expect(rhythmFromStatus(undefined, 50, [1200, 1200, 1200])).toBe('BRADY');
    expect(rhythmFromStatus(undefined, 75, [800, 820, 790])).toBe('NSR');
  });
});

describe('buildECGComplex', () => {
  it('construye complejo completo con flags por ritmo', () => {
    const c = buildECGComplex(5000, 1000, 'PVC');
    expect(c.rPeakTime).toBe(5000);
    expect(c.hasP).toBe(false);
    expect(c.isWideQrs).toBe(true);
    expect(c.samples.length).toBeGreaterThan(10);
  });
});

describe('ECGWaveformSynthesizer', () => {
  it('muestrea 60 Hz con la P antes del pico R y marca isPeak en R', () => {
    const synth = new ECGWaveformSynthesizer({ bufferSize: 8 });
    const t0 = 1000;
    synth.onHeartBeat(t0, 1000, 'NSR'); // pico R real en t0
    const points = synth.sample(t0 + 500); // arranca en complejoStart (t0 - rPeakOffset)

    // La primera muestra cae antes del pico R (onda P visible).
    expect(points.length).toBeGreaterThan(25);
    expect(points.length).toBeLessThan(45);
    const first = points[0];
    expect(first.time).toBeLessThan(t0);

    // El pico R (t0) está muestreado y marcado.
    const peakPoint = points.find((p) => p.isPeak);
    expect(peakPoint).toBeDefined();
    expect(peakPoint!.y).toBeGreaterThan(0.9); // R ≈ 1.0
  });

  it('ignora latidos dentro del período refractario', () => {
    const synth = new ECGWaveformSynthesizer({ refractoryMs: 250 });
    const c1 = synth.onHeartBeat(1000, 800, 'NSR');
    const c2 = synth.onHeartBeat(1200, 800, 'NSR'); // 200ms < 250ms
    expect(c1).not.toBeNull();
    expect(c2).toBeNull();
  });

  it('buffer FIFO con límite y reset limpio', () => {
    const synth = new ECGWaveformSynthesizer({ bufferSize: 24, refractoryMs: 1 });
    for (let i = 0; i < 40; i++) {
      synth.onHeartBeat(1000 + i * 800, 800, 'NSR');
    }
    expect(synth.getBufferedPoints()).toBeDefined();
    synth.reset();
    expect(synth.getBufferedPoints()).toEqual([]);
  });

  it('muestreo continuo sin solapamiento ni huecos tras sample incremental', () => {
    const synth = new ECGWaveformSynthesizer({ sampleRateHz: 60 });
    const a = synth.sample(500);
    const b = synth.sample(1000);
    expect(a.length).toBe(1); // primer sample en el instante inicial
    expect(b.length).toBeGreaterThan(25);
    const all = [...a, ...b];
    for (let i = 1; i < all.length; i++) {
      const dt = all[i].time - all[i - 1].time;
      expect(dt).toBeGreaterThan(10);
      expect(dt).toBeLessThan(25);
    }
  });

  it('PVC: el tramo del latido se marca como arritmia', () => {
    const synth = new ECGWaveformSynthesizer({ bufferSize: 8 });
    const t0 = 1000;
    synth.onHeartBeat(t0, 1000, 'PVC');
    const points = synth.sample(t0 + 300);
    const arrhythmic = points.filter((p) => p.isArrhythmia);
    expect(arrhythmic.length).toBeGreaterThan(0);
    // Los puntos arrítmicos corresponden a la morfología PVC (tinte rojo).
    expect(arrhythmic[0].rhythm).toBe('PVC');
  });
});

describe('evaluateECGComplex (hot path)', () => {
  it('es función pura: mismo RR/config/rScale → mismo valor', () => {
    const config = getRhythmConfig('NSR');
    expect(evaluateECGComplex(120.5, 1000, config, 0.95)).toBe(
      evaluateECGComplex(120.5, 1000, config, 0.95)
    );
  });

  it('fuera del complejo contribuye 0 (pausa TP isoeléctrica)', () => {
    const config = getRhythmConfig('NSR');
    expect(evaluateECGComplex(99999, 1000, config, 1)).toBeCloseTo(0, 1);
  });
});
