/**
 * FILTRO PASABANDA IIR BUTTERWORTH 0.3-5Hz - OPTIMIZADO PARA PPG
 *
 * CRÍTICO PARA DETECCIÓN DE LATIDOS:
 * - Frecuencia cardíaca: 18-300 BPM = 0.3-5 Hz (rango amplio para robustez)
 * - Elimina DC (línea base, cambios lentos de iluminación)
 * - Elimina alta frecuencia (ruido eléctrico, vibraciones, movimiento)
 *
 * IMPLEMENTACIÓN: wrapper sobre BandpassBiquad (biquadFilter.ts),
 * única implementación biquad del repo. Mantiene la API legacy (filter/reset/
 * setSampleRate) para no tocar a PPGSignalProcessor ni a los tests.
 *
 * Referencias:
 * - De Haan & Jeanne 2013: CHROM/POS para rPPG
 * - webcam-pulse-detector de thearn (GitHub 3.2k stars)
 * - https://scipy-cookbook.readthedocs.io/items/ButterworthBandpass.html
 */
import { BandpassBiquad } from './biquadFilter';

export class BandpassFilter {
  private readonly bp: BandpassBiquad;
  private sampleRate: number;

  constructor(sampleRate: number = 30) {
    this.sampleRate = sampleRate;
    this.bp = new BandpassBiquad(sampleRate, 0.3, 5.0);
  }

  /**
   * FILTRO PASABANDA COMPLETO
   * Aplica HPF 0.3Hz -> LPF 5Hz en cascada
   *
   * @param value Valor crudo de entrada (ej: intensidad rojo promedio)
   * @returns Valor filtrado con solo componentes de frecuencia cardíaca
   */
  filter(value: number): number {
    return this.bp.process(value);
  }

  /**
   * Resetear estados del filtro
   */
  reset(): void {
    this.bp.reset();
  }

  /**
   * Cambiar frecuencia de muestreo
   */
  setSampleRate(rate: number): void {
    this.sampleRate = rate;
    this.bp.setSampleRate(rate);
  }
}
