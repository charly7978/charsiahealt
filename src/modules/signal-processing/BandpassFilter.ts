/**
 * FILTRO PASABANDA IIR BUTTERWORTH 0.3-5Hz - OPTIMIZADO PARA PPG
 *
 * - Coeficientes Butterworth 2do orden (cascada HPF + LPF)
 * - Estado y coeficientes en Float64Array (zero-allocation reset)
 */
export class BandpassFilter {
  // Coeficientes (Float64 — sin allocaciones en reset)
  private readonly hpfB = new Float64Array(3);
  private readonly hpfA = new Float64Array(3);
  private readonly lpfB = new Float64Array(3);
  private readonly lpfA = new Float64Array(3);

  // Estados internos (Float64Array circulares de 3)
  private readonly hpfX = new Float64Array(3);
  private readonly hpfY = new Float64Array(3);
  private readonly lpfX = new Float64Array(3);
  private readonly lpfY = new Float64Array(3);

  private sampleRate: number;
  private initialized = false;

  constructor(sampleRate: number = 30) {
    this.sampleRate = sampleRate;
    this.hpfA[0] = 1;
    this.lpfA[0] = 1;
    this.computeCoefficients();
  }

  private computeCoefficients(): void {
    const fs = this.sampleRate;

    // === PASA-ALTOS a 0.3Hz ===
    const fcHp = 0.3;
    const wcHp = Math.tan(Math.PI * fcHp / fs);
    const kHp = wcHp;
    const normHp = 1 / (1 + Math.SQRT2 * kHp + kHp * kHp);

    this.hpfB[0] = normHp;
    this.hpfB[1] = -2 * normHp;
    this.hpfB[2] = normHp;
    this.hpfA[0] = 1;
    this.hpfA[1] = 2 * (kHp * kHp - 1) * normHp;
    this.hpfA[2] = (1 - Math.SQRT2 * kHp + kHp * kHp) * normHp;

    // === PASA-BAJOS a 5Hz ===
    const fcLp = 5.0;
    const wcLp = Math.tan(Math.PI * fcLp / fs);
    const kLp = wcLp;
    const normLp = 1 / (1 + Math.SQRT2 * kLp + kLp * kLp);

    this.lpfB[0] = kLp * kLp * normLp;
    this.lpfB[1] = 2 * kLp * kLp * normLp;
    this.lpfB[2] = kLp * kLp * normLp;
    this.lpfA[0] = 1;
    this.lpfA[1] = 2 * (kLp * kLp - 1) * normLp;
    this.lpfA[2] = (1 - Math.SQRT2 * kLp + kLp * kLp) * normLp;

    this.initialized = true;
  }

  private applyBiquad(
    input: number,
    b: Float64Array,
    a: Float64Array,
    x: Float64Array,
    y: Float64Array,
  ): number {
    x[2] = x[1]; x[1] = x[0]; x[0] = input;
    y[2] = y[1]; y[1] = y[0];
    y[0] = b[0] * x[0] + b[1] * x[1] + b[2] * x[2] - a[1] * y[1] - a[2] * y[2];
    if (!isFinite(y[0]) || Math.abs(y[0]) > 1e10) y[0] = 0;
    return y[0];
  }

  /**
   * FILTRO PASABANDA COMPLETO (HPF 0.3Hz → LPF 5Hz en cascada)
   */
  filter(value: number): number {
    if (!this.initialized || !isFinite(value)) return 0;
    const hp = this.applyBiquad(value, this.hpfB, this.hpfA, this.hpfX, this.hpfY);
    return this.applyBiquad(hp, this.lpfB, this.lpfA, this.lpfX, this.lpfY);
  }

  reset(): void {
    this.hpfX.fill(0);
    this.hpfY.fill(0);
    this.lpfX.fill(0);
    this.lpfY.fill(0);
  }

  setSampleRate(rate: number): void {
    this.sampleRate = rate;
    this.computeCoefficients();
    this.reset();
  }
}
