/**
 * HEARTBEAT PROCESSOR - FUSIÓN TIEMPO + FRECUENCIA
 *
 * Detección de latidos (van Gent / Elgendi style):
 * 1. Umbral adaptativo que sigue la altura de los picos aceptados recientes
 *    (resiste ráfagas de ruido y cambios lentos de amplitud).
 * 2. Máximo local estricto en ventana con contexto futuro + prominencia + morfología.
 * 3. Período refractario adaptativo según RR esperado.
 * 4. Search-back: reescanea el buffer para recuperar latidos perdidos en huecos
 *    (elimina silencios/baches) en vez de registrar un intervalo doble.
 * 5. Fusión tiempo+dominio frecuencial (Welch PSD) para el BPM mostrado.
 */
export class HeartBeatProcessor {
  private readonly MIN_PEAK_INTERVAL_MS = 330;
  private readonly MAX_PEAK_INTERVAL_MS = 2000;

  private signalBuffer: number[] = [];
  private derivativeBuffer: number[] = [];
  private timestampBuffer: number[] = [];
  private readonly BUFFER_SIZE = 300;

  private lastPeakTime = 0;
  private lastPeakValue = 0;
  private recentPeakHeights: number[] = [];

  private rrIntervals: number[] = [];
  private readonly MAX_RR_INTERVALS = 30;
  private smoothBPM = 0;
  private frequencyBPM = 0;
  private periodicityScore = 0;

  private audioContext: AudioContext | null = null;
  private audioUnlocked = false;
  private lastBeepTime = 0;

  private consecutivePeaks = 0;
  private signalQualityIndex = 0;

  constructor() {
    this.setupAudio();
  }

  private setupAudio() {
    const unlock = async () => {
      if (this.audioUnlocked) return;
      try {
        const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.audioContext = new AudioContextClass();
        await this.audioContext.resume();
        this.audioUnlocked = true;
        document.removeEventListener('touchstart', unlock);
        document.removeEventListener('click', unlock);
      } catch { /* ignore */ }
    };
    document.addEventListener('touchstart', unlock, { passive: true });
    document.addEventListener('click', unlock, { passive: true });
  }

  processSignal(filteredValue: number, timestamp?: number): {
    bpm: number;
    confidence: number;
    isPeak: boolean;
    filteredValue: number;
    arrhythmiaCount: number;
    sqi: number;
  } {
    const now = timestamp ?? Date.now();

    this.signalBuffer.push(filteredValue);
    this.timestampBuffer.push(now);
    if (this.signalBuffer.length > this.BUFFER_SIZE) {
      this.signalBuffer.shift();
      this.timestampBuffer.shift();
    }

    const derivative = this.calculateDerivative();
    this.derivativeBuffer.push(derivative);
    if (this.derivativeBuffer.length > this.BUFFER_SIZE) {
      this.derivativeBuffer.shift();
    }

    if (this.signalBuffer.length < 20) {
      return { bpm: 0, confidence: 0, isPeak: false, filteredValue: 0, arrhythmiaCount: 0, sqi: 0 };
    }

    // === GATE: minimum signal energy to reject noise ===
    const recentForGate = this.signalBuffer.slice(-60);
    const gSorted = [...recentForGate].sort((a, b) => a - b);
    const gRange = (gSorted[Math.floor(gSorted.length * 0.9)] ?? 0) - (gSorted[Math.floor(gSorted.length * 0.1)] ?? 0);
    if (gRange < 0.5) {
      return { bpm: 0, confidence: 0, isPeak: false, filteredValue: 0, arrhythmiaCount: 0, sqi: 0 };
    }

    // Adaptive window for normalization
    const windowLen = this.consecutivePeaks < 3 ? 90 : 150;
    const { normalizedValue, range } = this.normalizeSignal(filteredValue, windowLen);
    
    const periodicity = this.estimatePeriodicity();
    this.periodicityScore = periodicity.score;

    if (periodicity.bpm > 0) {
      this.frequencyBPM = this.frequencyBPM === 0
        ? periodicity.bpm
        : this.frequencyBPM * 0.82 + periodicity.bpm * 0.18;
    } else {
      this.frequencyBPM = this.frequencyBPM * 0.94;
    }

    this.signalQualityIndex = this.calculateSQI(range, this.periodicityScore);

    const expectedRR = this.getExpectedRR();
    const minInterval = Math.max(this.MIN_PEAK_INTERVAL_MS, expectedRR > 0 ? expectedRR * 0.5 : 0);
    const maxInterval = this.MAX_PEAK_INTERVAL_MS;

    // Detect on a sample with future context (5-frame delay) so morphology is reliable
    const ctx = 5;
    const tailLen = 11;
    const tTail = this.timestampBuffer.slice(-tailLen);
    const peakTime = tTail.length >= tailLen ? tTail[tailLen - 1 - ctx] : now;
    const timeSinceLastPeak = this.lastPeakTime > 0 ? peakTime - this.lastPeakTime : Number.MAX_SAFE_INTEGER;

    let isPeak = false;

    if (timeSinceLastPeak >= minInterval) {
      const peakVal = this.detectPeak();
      if (peakVal >= 0) {
        this.acceptPeak(peakTime, timeSinceLastPeak, peakVal);
        isPeak = true;
      }
    }

    // === SEARCH-BACK: recover beats missed during gaps (fixes silence/hole artifacts) ===
    if (
      !isPeak &&
      this.lastPeakTime > 0 &&
      timeSinceLastPeak > expectedRR * 1.5 &&
      timeSinceLastPeak < maxInterval
    ) {
      const missed = this.scanForMissedPeak(this.lastPeakTime, peakTime, minInterval);
      if (missed && missed.time > this.lastPeakTime + minInterval) {
        this.acceptPeak(missed.time, missed.time - this.lastPeakTime, missed.value);
        isPeak = true;
      }
    }

    if (!isPeak && this.lastPeakTime > 0 && timeSinceLastPeak > maxInterval) {
      this.consecutivePeaks = Math.max(0, this.consecutivePeaks - 1);
    }

    // === FUSIÓN TIEMPO + FRECUENCIA ===
    // BLOCK: never show frequency-only BPM without at least 1 confirmed time-domain peak
    let displayBPM = this.smoothBPM;

    if (this.frequencyBPM > 0 && this.consecutivePeaks >= 3) {
      if (this.consecutivePeaks < 5 || this.signalQualityIndex < 35) {
        // Weak signal — blend with caution
        displayBPM = displayBPM * 0.65 + this.frequencyBPM * 0.35;
      } else {
        // Strong signal — trust peaks more
        displayBPM = displayBPM * 0.88 + this.frequencyBPM * 0.12;
      }
    }
    // If no peaks confirmed yet, displayBPM stays 0 — no guessing

    const confidence = this.calculateConfidence();

    return {
      bpm: displayBPM,
      confidence,
      isPeak,
      filteredValue: normalizedValue,
      arrhythmiaCount: 0,
      sqi: this.signalQualityIndex,
    };
  }

  private calculateDerivative(): number {
    const n = this.signalBuffer.length;
    if (n < 3) return 0;
    return (this.signalBuffer[n - 1] - this.signalBuffer[n - 3]) * 0.5 + (this.signalBuffer[n - 1] - this.signalBuffer[n - 2]) * 0.5;
  }

  private getRobustBounds(values: number[]): { low: number; high: number; range: number } {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 0) return { low: 0, high: 0, range: 0 };
    const low = sorted[Math.floor((sorted.length - 1) * 0.1)] ?? sorted[0];
    const high = sorted[Math.floor((sorted.length - 1) * 0.9)] ?? sorted[sorted.length - 1];
    return { low, high, range: Math.max(0, high - low) };
  }

  private normalizeSignal(value: number, windowLen: number = 150): { normalizedValue: number; range: number } {
    const recent = this.signalBuffer.slice(-windowLen);
    const { low, high, range } = this.getRobustBounds(recent);
    if (range < 0.15) return { normalizedValue: 0, range: 0 };
    const clipped = Math.min(high, Math.max(low, value));
    const normalizedValue = ((clipped - low) / range - 0.5) * 120;
    return { normalizedValue, range };
  }

  private normalizeWindow(values: number[], windowLen: number = 150): number[] {
    const refWindow = this.signalBuffer.slice(-windowLen);
    const { low, high, range } = this.getRobustBounds(refWindow);
    if (range < 0.15) return values.map(() => 0);
    // NOTE: do NOT clamp to [low, high] here. Clamping flattens the systolic
    // peak (which sits just above p90) into a plateau, destroying the local
    // maximum that peak detection relies on. Mapping without clamping keeps
    // true peaks distinguishable from their shoulders.
    return values.map((v) => ((v - low) / range - 0.5) * 120);
  }

  private estimateSampleRate(): number {
    if (this.timestampBuffer.length < 10) return 30;
    const recent = this.timestampBuffer.slice(-50);
    const intervals: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      const d = recent[i] - recent[i - 1];
      if (d >= 10 && d <= 100) intervals.push(d);
    }
    if (intervals.length < 6) return 30;
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 33;
    return this.clamp(1000 / median, 20, 40);
  }

  private fft(signal: number[]): { real: number[]; imag: number[] } {
    const n = signal.length;
    if (n <= 1) return { real: signal, imag: signal.map(() => 0) };

    const bits = Math.log2(n);
    if (!Number.isInteger(bits)) {
      const pow2 = 1 << Math.ceil(bits);
      const padded = new Array(pow2).fill(0);
      for (let i = 0; i < n; i++) padded[i] = signal[i];
      return this.fft(padded);
    }

    const real = new Array(n).fill(0);
    const imag = new Array(n).fill(0);

    for (let i = 0; i < n; i++) {
      const j = parseInt(i.toString(2).padStart(bits, '0').split('').reverse().join(''), 2);
      real[j] = signal[i];
    }

    for (let s = 1; s <= bits; s++) {
      const m = 1 << s;
      const mPrev = m >> 1;
      const wReal = Math.cos(-2 * Math.PI / m);
      const wImag = Math.sin(-2 * Math.PI / m);

      for (let k = 0; k < n; k += m) {
        let wr = 1, wi = 0;
        for (let j = 0; j < mPrev; j++) {
          const tReal = wr * real[k + j + mPrev] - wi * imag[k + j + mPrev];
          const tImag = wr * imag[k + j + mPrev] + wi * real[k + j + mPrev];
          real[k + j + mPrev] = real[k + j] - tReal;
          imag[k + j + mPrev] = imag[k + j] - tImag;
          real[k + j] = real[k + j] + tReal;
          imag[k + j] = imag[k + j] + tImag;
          const wTemp = wr;
          wr = wr * wReal - wi * wImag;
          wi = wTemp * wImag + wi * wReal;
        }
      }
    }

    return { real, imag };
  }

  private welchPSD(signal: number[]): number[] {
    const windowSize = 128;
    const hopSize = 64;
    const numWindows = Math.max(1, Math.floor((signal.length - windowSize) / hopSize));

    const hannWindow = new Array(windowSize).fill(0).map((_, i) => 0.5 * (1 - Math.cos(2 * Math.PI * i / (windowSize - 1))));

    const psd = new Array(windowSize).fill(0);

    for (let w = 0; w < numWindows; w++) {
      const start = w * hopSize;
      const segment = signal.slice(start, start + windowSize).map((v, i) => v * hannWindow[i]);
      const { real, imag } = this.fft(segment);

      for (let k = 0; k < windowSize; k++) {
        const mag = real[k] * real[k] + imag[k] * imag[k];
        psd[k] += mag / numWindows;
      }
    }

    const psdOneSided = new Array(windowSize / 2).fill(0);
    for (let k = 0; k < windowSize / 2; k++) {
      psdOneSided[k] = k === 0 ? psd[k] : 2 * psd[k];
    }

    return psdOneSided;
  }

  private estimatePeriodicity(): { bpm: number; score: number } {
    if (this.signalBuffer.length < 64) return { bpm: 0, score: 0 };

    const sampleRate = this.estimateSampleRate();
    const signal = this.normalizeWindow(this.signalBuffer.slice(-256), 256);

    const mean = signal.reduce((s, v) => s + v, 0) / signal.length;
    const centered = signal.map((v) => v - mean);

    const psd = this.welchPSD(centered);

    const minBin = Math.max(1, Math.floor(0.667 * psd.length / (sampleRate / 2)));
    const maxBin = Math.min(psd.length - 1, Math.floor(3.0 * psd.length / (sampleRate / 2)));

    let bestBin = minBin;
    let bestPower = 0;
    for (let k = minBin; k <= maxBin; k++) {
      if (psd[k] > bestPower) {
        bestPower = psd[k];
        bestBin = k;
      }
    }

    const freq = (bestBin * sampleRate) / (2 * psd.length);
    const bpm = freq * 60;

    const noiseFloor = psd.slice(minBin, maxBin).reduce((a, b) => a + b, 0) / Math.max(1, maxBin - minBin + 1);
    const score = bestPower > 0 ? Math.min(1, (bestPower - noiseFloor) / (bestPower + noiseFloor + 1e-9)) : 0;

    return { bpm: this.clamp(bpm, 40, 180), score: this.clamp(score, 0, 1) };
  }

  private calculateSQI(range: number, periodicityScore: number): number {
    if (this.signalBuffer.length < 30) return 0;

    const rangeFactor = Math.min(1, range / 5) * 22;
    const derivWindow = this.derivativeBuffer.slice(-60);
    const meanAbsDeriv = derivWindow.length > 0
      ? derivWindow.reduce((s, v) => s + Math.abs(v), 0) / derivWindow.length
      : 0;
    const slopeFactor = Math.min(1, meanAbsDeriv / 1.0) * 14;

    let rrFactor = 0;
    if (this.rrIntervals.length >= 3) {
      const m = this.rrIntervals.reduce((a, b) => a + b, 0) / this.rrIntervals.length;
      const v = this.rrIntervals.reduce((a, rr) => a + (rr - m) ** 2, 0) / this.rrIntervals.length;
      const cv = Math.sqrt(v) / Math.max(1, m);
      rrFactor = Math.max(0, 1 - cv * 2) * 22;
    }

    const peakFactor = Math.min(1, this.consecutivePeaks / 4) * 20;
    const periodicityFactor = periodicityScore * 22;

    return this.clamp(rangeFactor + slopeFactor + rrFactor + peakFactor + periodicityFactor, 0, 100);
  }

  private getExpectedRR(): number {
    if (this.rrIntervals.length >= 3) {
      const recent = this.rrIntervals.slice(-6).sort((a, b) => a - b);
      return recent[Math.floor(recent.length / 2)] ?? recent[0] ?? 0;
    }
    if (this.frequencyBPM > 0) return 60000 / this.frequencyBPM;
    return 0;
  }

  // === PEAK DETECTION (adaptive threshold + morphology, van Gent / Elgendi style) ===
  // Returns the normalized peak height if a peak is found at the current sample, else -1.
  private detectPeak(): number {
    const tailLen = 11;
    const tail = this.signalBuffer.slice(-tailLen);
    if (tail.length < tailLen) return -1;

    const winLen = this.consecutivePeaks < 3 ? 90 : 150;
    const norm = this.normalizeWindow(tail, winLen);
    const ci = 5;
    const center = norm[ci];

    // Strict local maximum in a 5-sample neighborhood (both sides have context)
    const isLocalMax =
      center > norm[ci - 1] &&
      center >= norm[ci - 2] &&
      center > norm[ci - 3] &&
      center >= norm[ci - 4] &&
      center > norm[ci + 1] &&
      center >= norm[ci + 2] &&
      center > norm[ci + 3] &&
      center >= norm[ci + 4];
    if (!isLocalMax) return -1;

    const localMin = Math.min(
      norm[ci - 4], norm[ci - 3], norm[ci - 2], norm[ci - 1],
      center,
      norm[ci + 1], norm[ci + 2], norm[ci + 3], norm[ci + 4]
    );
    const prominence = center - localMin;

    const threshold = this.adaptiveThreshold();
    if (center < threshold) return -1;
    if (prominence < 2.0) return -1;

    const rising = center - norm[ci - 3];
    if (rising < 1.0) return -1;

    // Amplitude consistency with previous accepted peak — rejects transient spikes
    if (this.lastPeakValue > 0) {
      const ratio = Math.abs(center) / Math.max(1, Math.abs(this.lastPeakValue));
      if (ratio < 0.12 || ratio > 7) return -1;
    }

    // First beat: require a clearly defined peak to avoid false starts
    if (this.consecutivePeaks === 0 && center < threshold * 1.3) return -1;

    return center;
  }

  // Adaptive threshold tracks the height of recent accepted peaks so it resists single
  // noise bursts and follows slow amplitude changes (van Gent-style moving baseline).
  private adaptiveThreshold(): number {
    if (this.recentPeakHeights.length < 2) return 3.0;
    const mean = this.recentPeakHeights.reduce((a, b) => a + b, 0) / this.recentPeakHeights.length;
    return Math.max(2.2, mean * 0.45);
  }

  private acceptPeak(peakTime: number, interval: number, peakValue: number): void {
    if (
      this.lastPeakTime > 0 &&
      interval >= this.MIN_PEAK_INTERVAL_MS * 0.4 &&
      interval <= this.MAX_PEAK_INTERVAL_MS
    ) {
      this.rrIntervals.push(interval);
      if (this.rrIntervals.length > this.MAX_RR_INTERVALS) this.rrIntervals.shift();

      const instantBPM = 60000 / interval;
      if (this.smoothBPM === 0) {
        this.smoothBPM = instantBPM;
      } else {
        const relativeDiff = Math.abs(instantBPM - this.smoothBPM) / Math.max(1, this.smoothBPM);
        let alpha = 0.25;
        if (relativeDiff > 0.30) alpha = 0.08;
        else if (relativeDiff > 0.18) alpha = 0.15;
        if (this.consecutivePeaks < 5) alpha = Math.max(0.06, alpha - 0.08);
        this.smoothBPM = this.smoothBPM * (1 - alpha) + instantBPM * alpha;
      }
      this.consecutivePeaks++;
    }
    this.lastPeakTime = peakTime;
    this.lastPeakValue = peakValue;
    this.recentPeakHeights.push(Math.abs(peakValue));
    if (this.recentPeakHeights.length > 12) this.recentPeakHeights.shift();
    this.vibrate();
    this.playBeep();
  }

  // Rescan the buffer between two beats for a missed local maximum (search-back).
  private scanForMissedPeak(fromTime: number, toTime: number, minInterval: number): { time: number; value: number } | null {
    let idxFrom = this.timestampBuffer.findIndex((t) => t > fromTime);
    if (idxFrom < 0) idxFrom = 0;
    const idxTo = this.timestampBuffer.length - 1;
    if (idxTo - idxFrom < 9) return null;

    const slice = this.signalBuffer.slice(idxFrom, idxTo + 1);
    const ts = this.timestampBuffer.slice(idxFrom, idxTo + 1);
    const norm = this.normalizeWindow(slice, 150);
    const threshold = this.adaptiveThreshold();

    let best: { time: number; value: number } | null = null;
    for (let ci = 4; ci < norm.length - 4; ci++) {
      const center = norm[ci];
      const isLocalMax =
        center > norm[ci - 1] && center >= norm[ci - 2] && center > norm[ci - 3] && center >= norm[ci - 4] &&
        center > norm[ci + 1] && center >= norm[ci + 2] && center > norm[ci + 3] && center >= norm[ci + 4];
      if (!isLocalMax) continue;

      const localMin = Math.min(
        norm[ci - 4], norm[ci - 3], norm[ci - 2], norm[ci - 1], center,
        norm[ci + 1], norm[ci + 2], norm[ci + 3], norm[ci + 4]
      );
      const prominence = center - localMin;
      if (center < threshold || prominence < 2.0) continue;
      if (!best || center > best.value) best = { time: ts[ci], value: center };
    }
    return best;
  }

  private calculateConfidence(): number {
    const sqiFactor = this.signalQualityIndex / 100;
    const peakSupport = Math.min(1, this.consecutivePeaks / 5);

    if (this.rrIntervals.length < 2) {
      return this.clamp(sqiFactor * 0.22 + peakSupport * 0.2 + this.periodicityScore * 0.3, 0, 0.6);
    }

    const mean = this.rrIntervals.reduce((a, b) => a + b, 0) / this.rrIntervals.length;
    const variance = this.rrIntervals.reduce((a, rr) => a + (rr - mean) ** 2, 0) / this.rrIntervals.length;
    const cv = Math.sqrt(variance) / Math.max(1, mean);
    const rrStability = this.clamp(1 - cv * 1.7, 0, 1);

    return this.clamp(rrStability * 0.32 + peakSupport * 0.24 + sqiFactor * 0.2 + this.periodicityScore * 0.24, 0, 1);
  }

  private vibrate(): void {
    try { if (navigator.vibrate) navigator.vibrate(55); } catch { /* ignore */ }
  }

  private async playBeep(): Promise<void> {
    if (!this.audioContext || !this.audioUnlocked) return;
    const now = Date.now();
    if (now - this.lastBeepTime < 220) return;
    try {
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      const t = this.audioContext.currentTime;
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      osc.frequency.setValueAtTime(820, t);
      osc.frequency.exponentialRampToValueAtTime(460, t + 0.08);
      gain.gain.setValueAtTime(0.12, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      osc.connect(gain);
      gain.connect(this.audioContext.destination);
      osc.start(t);
      osc.stop(t + 0.12);
      this.lastBeepTime = now;
    } catch { /* ignore */ }
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  getRRIntervals(): number[] { return [...this.rrIntervals]; }
  getLastPeakTime(): number { return this.lastPeakTime; }
  getSQI(): number { return this.signalQualityIndex; }
  getDerivativeBuffer(): number[] { return [...this.derivativeBuffer]; }


  reset(): void {
    this.signalBuffer = [];
    this.derivativeBuffer = [];
    this.timestampBuffer = [];
    this.rrIntervals = [];
    this.smoothBPM = 0;
    this.frequencyBPM = 0;
    this.periodicityScore = 0;
    this.lastPeakTime = 0;
    this.lastPeakValue = 0;
    this.recentPeakHeights = [];
    this.consecutivePeaks = 0;
    this.signalQualityIndex = 0;
  }

  dispose(): void {
    if (this.audioContext) this.audioContext.close().catch(() => {});
  }
}
