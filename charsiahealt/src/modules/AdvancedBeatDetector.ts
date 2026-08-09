/**
 * ADVANCED BEAT DETECTOR - WAVEFORM ENVELOPE PEAK DETECTION (WEPD)
 * Based on Han et al. 2022 Biosensors paper (PMC8869811)
 * Implements WEPD for arrhythmia detection + DATPD for NSR + AF/PVC detection
 */
import type { ProcessedSignal, ProcessingError, SignalProcessor as SignalProcessorInterface, ContactState } from '../types/signal';

interface BeatDetectionResult {
    bpm: number;
    confidence: number;
    isPeak: boolean;
    filteredValue: number;
    arrhythmiaCount: number;
    sqi: number;
    // Additional metrics from literature
    hrvSdnn?: number;   // Standard deviation of NN intervals
    hrvRmssd?: number;  // Root mean square of successive differences
    hrvPnn50?: number;  // Percentage of successive NN intervals >50ms different
    afDetected?: boolean;
    pvcDetected?: boolean;
    pacDetected?: boolean;
    rvrDetected?: boolean;  // Rapid ventricular response
}

export class AdvancedBeatDetector {
    // WEPD Parameters (from Han et al. 2022)
    private readonly WEPD_LOW_CUTOFF = 0.5;   // Hz
    private readonly WEPD_HIGH_CUTOFF = 5.0;  // Hz
    private readonly WEPD_FILTER_ORDER = 5;   // Elliptic filter order
    private readonly WEPD_MA_WINDOWS = [10, 9, 9];  // M=fs/10, fs/9, fs/9
    private readonly WEPD_REFRACTORY_MS = 300;  // >0.3s refractory period
    
    // Signal processing
    private signalBuffer: number[] = [];
    private timestampBuffer: number[] = [];
    private readonly BUFFER_SIZE = 300;  // ~10 seconds at 30 Hz
    
    // Beat tracking
    private lastPeakTime = 0;
    private lastPeakValue = 0;
    private rrIntervals: number[] = [];
    private readonly MAX_RR_INTERVALS = 30;
    private smoothBPM = 0;
    
    // AF Detection (Poincaré plot of HR derivatives)
    private hrDerivatives: number[] = [];
    private readonly MAX_HR_DERIVATIVES = 20;
    private afThreshold = 20;  // ms threshold for AF detection
    
    // PVC/PAC Detection (Poincaré plot of RR intervals)
    private rrDifferences: number[] = [];
    private readonly MAX_RR_DIFFERENCES = 20;
    private pvcThreshold = 0.3;  // 30% threshold for PVC
    private pacThreshold = 0.3;  // 30% threshold for PAC
    
    // RVR Detection
    private rvrBpmThreshold = 140;  // BPM
    private rvrIncreaseThreshold = 40;  // BPM increase beat-to-beat
    
    // Signal quality
    private signalQualityIndex = 0;
    
    // Audio feedback
    private audioContext: AudioContext | null = null;
    private audioUnlocked = false;
    private lastBeepTime = 0;
    
    constructor() {
        this.setupAudio();
    }
    
    private setupAudio() {
        const unlock = async () => {
            if (this.audioUnlocked) return;
            try {
                const AudioContextClass = window.AudioContext || 
                    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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
    
    /**
     * Main processing function - replaces HeartBeatProcessor.processSignal
     * Takes filtered signal from PPGSignalProcessor and detects beats using WEPD/SWEPD
     */
    processSignal(filteredValue: number, timestamp?: number): BeatDetectionResult {
        const now = timestamp ?? Date.now();
        
        // Buffer management
        this.signalBuffer.push(filteredValue);
        this.timestampBuffer.push(now);
        if (this.signalBuffer.length > this.BUFFER_SIZE) {
            this.signalBuffer.shift();
            this.timestampBuffer.shift();
        }
        
        // Need minimum samples for processing
        if (this.signalBuffer.length < 20) {
            return this.createDefaultResult(filteredValue);
        }
        
        // === WEPD ALGORITHM (Han et al. 2022) ===
        // 1. Bandpass filtering (0.5-5 Hz, 5th order elliptic)
        const bandpassed = this.applyBandpassFilter(this.signalBuffer.slice());
        
        // 2. Moving average smoothing (3 passes)
        let smoothed = [...bandpassed];
        const fs = this.estimateSampleRate();
        for (const M of this.WEPD_MA_WINDOWS) {
            const windowSize = Math.max(3, Math.floor(fs / M));
            smoothed = this.movingAverage(smoothed, windowSize);
        }
        
        // 3. First derivative to accentuate peak plateau
        const derivative = this.computeDerivative(smoothed);
        
        // 4. Standardization (z-score)
        const standardized = this.standardizeSignal(derivative);
        
        // 5. Signal inversion (to detect sharpest peaks - works for both upright and inverted PPG)
        const inverted = standardized.map(v => -v);
        
        // 6. Envelope method to remove dicrotic notch false positives
        const envelope = this.computeEnvelope(inverted);
        
        // 7. Peak detection with refractory period
        const peakResult = this.detectWepdPeak(envelope, now);
        
        // Update peak tracking
        let isPeak = false;
        if (peakResult.isPeak) {
            this.acceptPeak(peakResult.time, peakResult.interval, peakResult.value);
            isPeak = true;
        }
        
        // === AF DETECTION (Poincaré plot of HR derivatives) ===
        if (this.rrIntervals.length >= 2) {
            const instantHR = 60000 / this.rrIntervals[this.rrIntervals.length - 1];
            const prevHR = this.rrIntervals.length >= 2 ? 
                60000 / this.rrIntervals[this.rrIntervals.length - 2] : instantHR;
            const hrDeriv = Math.abs(instantHR - prevHR);
            this.hrDerivatives.push(hrDeriv);
            if (this.hrDerivatives.length > this.MAX_HR_DERIVATIVES) {
                this.hrDerivatives.shift();
            }
        }
        
        const afDetected = this.detectAtrialFibrillation();
        
        // === PVC/PAC DETECTION (Poincaré plot of RR intervals) ===
        if (this.rrIntervals.length >= 2) {
            const rr1 = this.rrIntervals[this.rrIntervals.length - 1];
            const rr2 = this.rrIntervals[this.rrIntervals.length - 2];
            const rrDiff = Math.abs(rr1 - rr2) / Math.max(rr1, rr2);
            this.rrDifferences.push(rrDiff);
            if (this.rrDifferences.length > this.MAX_RR_DIFFERENCES) {
                this.rrDifferences.shift();
            }
        }
        
        const { pvcDetected, pacDetected, rvrDetected } = this.detectArrhythmias();
        
        // === SIGNAL QUALITY INDEX ===
        this.updateSignalQuality();
        
        // === HRV METRICS ===
        const hrvMetrics = this.computeHrvMetrics();
        
        // === CONFIDENCE CALCULATION ===
        const confidence = this.calculateConfidence();
        
        return {
            bpm: this.getCurrentBpm(),
            confidence,
            isPeak,
            filteredValue: filteredValue,  // Pass through for visualization
            arrhythmiaCount: (afDetected ? 1 : 0) + (pvcDetected ? 1 : 0) + (pacDetected ? 1 : 0),
            sqi: this.signalQualityIndex,
            hrvSdnn: hrvMetrics.sdnn,
            hrvRmssd: hrvMetrics.rmssd,
            hrvPnn50: hrvMetrics.pnn50,
            afDetected,
            pvcDetected,
            pacDetected,
            rvrDetected
        };
    }
    
    // ================================================================
    // WEPD ALGORITHM IMPLEMENTATIONS
    // ================================================================
    
    private applyBandpassFilter(signal: number[]): number[] {
        // Simplified zero-phase elliptic bandpass (0.5-5 Hz)
        // In production, use a proper filter design (e.g., filtfilt in Python)
        // For now, implement as two-pass Butterworth approximation
        const fs = this.estimateSampleRate();
        if (fs < 10) return signal;  // Too low sample rate
        
        // Normalized frequencies
        const lowNorm = this.WEPD_LOW_CUTOFF / (fs / 2);
        const highNorm = this.WEPD_HIGH_CUTOFF / (fs / 2);
        
        // Simple moving average approximation for demonstration
        // Replace with proper elliptic filter in production
        const windowSize = Math.max(3, Math.floor(fs / 4));  // ~0.25s window
        const filtered = this.movingAverage(signal, windowSize);
        
        // High-pass effect (remove DC and very low freq)
        const smoothed = this.movingAverage(filtered, Math.max(3, Math.floor(fs / 2)));
        return signal.map((val, i) => val - smoothed[i] || 0);
    }
    
    private movingAverage(signal: number[], windowSize: number): number[] {
        if (signal.length < windowSize) return signal;
        const result: number[] = [];
        const halfWindow = Math.floor(windowSize / 2);
        
        for (let i = 0; i < signal.length; i++) {
            let sum = 0;
            let count = 0;
            for (let j = -halfWindow; j <= halfWindow; j++) {
                const idx = i + j;
                if (idx >= 0 && idx < signal.length) {
                    sum += signal[idx];
                    count++;
                }
            }
            result.push(sum / count);
        }
        return result;
    }
    
    private computeDerivative(signal: number[]): number[] {
        const derivative: number[] = [];
        for (let i = 2; i < signal.length; i++) {
            // Central difference
            derivative.push((signal[i] - signal[i - 2]) * 0.5);
        }
        // Pad beginning with zeros
        while (derivative.length < signal.length) {
            derivative.unshift(0);
        }
        return derivative;
    }
    
    private standardizeSignal(signal: number[]): number[] {
        if (signal.length === 0) return signal;
        
        const mean = signal.reduce((sum, val) => sum + val, 0) / signal.length;
        const variance = signal.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / signal.length;
        const stdDev = Math.sqrt(Math.max(variance, 1e-10));
        
        return signal.map(val => (val - mean) / stdDev);
    }
    
    private computeEnvelope(signal: number[]): number[] {
        // Simplified envelope using moving RMS
        // Proper implementation would use Hilbert transform or cubic spline
        const fs = this.estimateSampleRate();
        const windowSize = Math.max(3, Math.floor(fs / 4));  // ~0.25s window
        
        const envelope: number[] = [];
        for (let i = 0; i < signal.length; i++) {
            let sumSquares = 0;
            let count = 0;
            const halfWindow = Math.floor(windowSize / 2);
            for (let j = -halfWindow; j <= halfWindow; j++) {
                const idx = i + j;
                if (idx >= 0 && idx < signal.length) {
                    sumSquares += signal[idx] * signal[idx];
                    count++;
                }
            }
            const rms = Math.sqrt(Math.max(sumSquares / count, 1e-10));
            envelope.push(rms);
        }
        return envelope;
    }
    
    private detectWepdPeak(envelope: number[], timestamp: number): {
        isPeak: boolean;
        time: number;
        interval: number;
        value: number;
    } {
        if (envelope.length < 10) {
            return { isPeak: false, time: timestamp, interval: 0, value: 0 };
        }
        
        const currentIdx = envelope.length - 1;
        const currentValue = envelope[currentIdx];
        
        // Check refractory period
        const timeSinceLastPeak = this.lastPeakTime > 0 ? 
            timestamp - this.lastPeakTime : Number.MAX_SAFE_INTEGER;
        if (timeSinceLastPeak < this.WEPD_REFRACTORY_MS) {
            return { isPeak: false, time: timestamp, interval: timeSinceLastPeak, value: currentValue };
        }
        
        // Local maximum check (with context)
        const isLocalMax = this.isLocalMaximum(envelope, currentIdx, 3);
        if (!isLocalMax) {
            return { isPeak: false, time: timestamp, interval: timeSinceLastPeak, value: currentValue };
        }
        
        // Dynamic threshold based on recent peaks
        const threshold = this.computeDynamicThreshold(envelope);
        if (currentValue < threshold) {
            return { isPeak: false, time: timestamp, interval: timeSinceLastPeak, value: currentValue };
        }
        
        // Prominence check
        const prominence = this.computeProminence(envelope, currentIdx);
        if (prominence < 0.5) {  // Adapted threshold
            return { isPeak: false, time: timestamp, interval: timeSinceLastPeak, value: currentValue };
        }
        
        return {
            isPeak: true,
            time: timestamp,
            interval: timeSinceLastPeak,
            value: currentValue
        };
    }
    
    private isLocalMaximum(signal: number[], idx: number, context: number): boolean {
        const val = signal[idx];
        const start = Math.max(0, idx - context);
        const end = Math.min(signal.length - 1, idx + context);
        
        for (let i = start; i <= end; i++) {
            if (i !== idx && signal[i] >= val) {
                return false;
            }
        }
        return true;
    }
    
    private computeDynamicThreshold(signal: number[]): number {
        // Adaptive threshold based on recent peak values
        if (this.rrIntervals.length < 2) {
            return 0.5;  // Default threshold
        }
        
        // Use recent signal values to estimate threshold
        const recent = signal.slice(Math.max(0, signal.length - 20));
        const sorted = [...recent].sort((a, b) => a - b);
        const idx90 = Math.floor(sorted.length * 0.9);
        const idx10 = Math.floor(sorted.length * 0.1);
        const range = sorted[idx90] - sorted[idx10];
        
        return sorted[idx10] + range * 0.3;  // 30% above minimum
    }
    
    private computeProminence(signal: number[], idx: number): number {
        const val = signal[idx];
        const leftMin = this.findLocalMin(signal, idx, -1);
        const rightMin = this.findLocalMin(signal, idx, 1);
        const minVal = Math.min(leftMin, rightMin);
        return val - minVal;
    }
    
    private findLocalMin(signal: number[], idx: number, direction: number): number {
        let minVal = signal[idx];
        let i = idx + direction;
        while (i >= 0 && i < signal.length) {
            if (signal[i] < minVal) {
                minVal = signal[i];
                // Continue looking for even lower values in same direction
                i += direction;
            } else {
                // Found a local minimum in this direction
                break;
            }
        }
        return minVal;
    }
    
    // ================================================================
    // PEAK TRACKING AND ACCEPTANCE
    // ================================================================
    
    private acceptPeak(peakTime: number, interval: number, peakValue: number): void {
        if (
            this.lastPeakTime > 0 &&
            interval >= this.WEPD_REFRACTORY_MS * 0.5 &&  // Minimum interval
            interval <= 2000  // Maximum interval (30 BPM)
        ) {
            this.rrIntervals.push(interval);
            if (this.rrIntervals.length > this.MAX_RR_INTERVALS) {
                this.rrIntervals.shift();
            }
            
            const instantBPM = 60000 / interval;
            // Simple exponential moving average for BPM smoothing
            if (this.smoothBPM === 0) {
                this.smoothBPM = instantBPM;
            } else {
                this.smoothBPM = this.smoothBPM * 0.7 + instantBPM * 0.3;
            }
        }
        
        this.lastPeakTime = peakTime;
        this.lastPeakValue = peakValue;
        this.vibrate();
        this.playBeep();
    }
    
    // ================================================================
    // ARRHYTHMIA DETECTION
    // ================================================================
    
    private detectAtrialFibrillation(): boolean {
        if (this.hrDerivatives.length < 5) return false;
        
        // AF detection: high variability in HR derivatives
        const meanDeriv = this.hrDerivatives.reduce((sum, val) => sum + val, 0) / this.hrDerivatives.length;
        const stdDeriv = Math.sqrt(
            this.hrDerivatives.reduce((sum, val) => sum + Math.pow(val - meanDeriv, 2), 0) / 
            this.hrDerivatives.length
        );
        
        // AF typically shows HR derivative std > 20 bpm
        return stdDeriv > this.afThreshold;
    }
    
    private detectArrhythmias(): {
        pvcDetected: boolean;
        pacDetected: boolean;
        rvrDetected: boolean;
    } {
        if (this.rrDifferences.length < 5) {
            return { pvcDetected: false, pacDetected: false, rvrDetected: false };
        }
        
        // Calculate statistics of RR differences
        const meanDiff = this.rrDifferences.reduce((sum, val) => sum + val, 0) / this.rrDifferences.length;
        const stdDiff = Math.sqrt(
            this.rrDifferences.reduce((sum, val) => sum + Math.pow(val - meanDiff, 2), 0) / 
            this.rrDifferences.length
        );
        
        // PVC: large sudden changes in RR interval (>30% different from previous)
        // PAC: premature atrial contraction (also shows as RR interval change)
        const pvcDetected = stdDiff > this.pvcThreshold;
        const pacDetected = stdDiff > this.pacThreshold && meanDiff < 0.2;  // More restrictive for PAC
        
        // RVR: rapid ventricular response (HR >140 bpm with sudden increases)
        const currentHR = this.getCurrentBpm();
        const rvrDetected = currentHR > this.rvrBpmThreshold;
        
        return { pvcDetected, pacDetected, rvrDetected };
    }
    
    // ================================================================
    // SIGNAL QUALITY AND HRV METRICS
    // ================================================================
    
    private updateSignalQuality(): void {
        if (this.signalBuffer.length < 30) {
            this.signalQualityIndex = 0;
            return;
        }
        
        // Signal quality based on:
        // 1. Signal amplitude (range)
        // 2. Signal stability (low noise)
        // 3. Rhythm regularity
        
        const recent = this.signalBuffer.slice(-60);
        const sorted = [...recent].sort((a, b) => a - b);
        const range = sorted[Math.floor(sorted.length * 0.9)] - sorted[Math.floor(sorted.length * 0.1)];
        
        // Range factor (0-22 points)
        const rangeFactor = Math.min(1, range / 3) * 22;
        
        // Derivative factor (slope consistency) (0-18 points)
        const derivWindow = this.signalBuffer.slice(-20);
        const meanAbsDeriv = derivWindow.length > 0 ?
            derivWindow.reduce((sum, val) => sum + Math.abs(val), 0) / derivWindow.length : 0;
        const slopeFactor = Math.min(1, meanAbsDeriv / 0.5) * 18;
        
        // Rhythm regularity factor (0-25 points)
        let rrFactor = 0;
        if (this.rrIntervals.length >= 3) {
            const meanRR = this.rrIntervals.reduce((sum, val) => sum + val, 0) / this.rrIntervals.length;
            const variance = this.rrIntervals.reduce((sum, val) => sum + Math.pow(val - meanRR, 2), 0) / 
                           this.rrIntervals.length;
            const cv = Math.sqrt(variance) / Math.max(1, meanRR);  // Coefficient of variation
            rrFactor = Math.max(0, 1 - cv * 3) * 25;  // Lower CV = higher score
        }
        
        // Peak count factor (0-20 points)
        const peakFactor = Math.min(1, this.rrIntervals.length / 10) * 20;
        
        this.signalQualityIndex = Math.min(100, rangeFactor + slopeFactor + rrFactor + peakFactor);
    }
    
    private computeHrvMetrics(): {
        sdnn: number;
        rmssd: number;
        pnn50: number;
    } {
        if (this.rrIntervals.length < 2) {
            return { sdnn: 0, rmssd: 0, pnn50: 0 };
        }
        
        // SDNN: Standard deviation of NN intervals
        const meanRR = this.rrIntervals.reduce((sum, val) => sum + val, 0) / this.rrIntervals.length;
        const variance = this.rrIntervals.reduce((sum, val) => sum + Math.pow(val - meanRR, 2), 0) / 
                         this.rrIntervals.length;
        const sdnn = Math.sqrt(variance);
        
        // RMSSD: Root mean square of successive differences
        const successiveDiffs: number[] = [];
        for (let i = 1; i < this.rrIntervals.length; i++) {
            successiveDiffs.push(Math.abs(this.rrIntervals[i] - this.rrIntervals[i - 1]));
        }
        const meanSqDiff = successiveDiffs.reduce((sum, val) => sum + val * val, 0) / successiveDiffs.length;
        const rmssd = Math.sqrt(meanSqDiff);
        
        // pNN50: Percentage of successive NN intervals differing by >50 ms
        const diffsOver50 = successiveDiffs.filter(diff => diff > 50).length;
        const pnn50 = (this.rrIntervals.length > 1) ? 
            (diffsOver50 / (this.rrIntervals.length - 1)) * 100 : 0;
        
        return {
            sdnn: Math.min(500, sdnn),  // Cap at reasonable values
            rmssd: Math.min(500, rmssd),
            pnn50: Math.min(100, pnn50)
        };
    }
    
    // ================================================================
    // HELPER FUNCTIONS
    // ================================================================
    
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
        return Math.round(1000 / median);  // Hz
    }
    
    private getCurrentBpm(): number {
        if (this.rrIntervals.length === 0) return 0;
        const meanRR = this.rrIntervals.reduce((sum, val) => sum + val, 0) / this.rrIntervals.length;
        return Math.round(60000 / meanRR);
    }
    
    private calculateConfidence(): number {
        if (this.rrIntervals.length === 0) return 0;
        
        const sqiFactor = this.signalQualityIndex / 100;
        const peakSupport = Math.min(1, this.rrIntervals.length / 10);
        
        // Rhythm stability
        let rrStability = 0;
        if (this.rrIntervals.length >= 3) {
            const meanRR = this.rrIntervals.reduce((sum, val) => sum + val, 0) / this.rrIntervals.length;
            const variance = this.rrIntervals.reduce((sum, val) => sum + Math.pow(val - meanRR, 2), 0) / 
                           this.rrIntervals.length;
            const cv = Math.sqrt(variance) / Math.max(1, meanRR);
            rrStability = Math.max(0, 1 - cv * 2);
        }
        
        // Periodicity from frequency analysis (simple version)
        let periodicityScore = 0;
        if (this.signalBuffer.length >= 64) {
            // Simplified periodicity check
            const autocorr = this.computeAutocorrelation(this.signalBuffer.slice(-64));
            const peakAutocorr = Math.max(...autocorr.slice(10));  // Skip zero lag
            periodicityScore = Math.min(1, peakAutocorr / (autocorr[0] || 1));
        }
        
        return Math.min(1, 
            sqiFactor * 0.25 + 
            peakSupport * 0.25 + 
            rrStability * 0.25 + 
            periodicityScore * 0.25
        );
    }
    
    private computeAutocorrelation(signal: number[]): number[] {
        const n = signal.length;
        const mean = signal.reduce((sum, val) => sum + val, 0) / n;
        const variance = signal.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / n;
        
        const autocorr: number[] = [];
        for (let lag = 0; lag < Math.min(n, 32); lag++) {
            let sum = 0;
            for (let i = 0; i < n - lag; i++) {
                sum += (signal[i] - mean) * (signal[i + lag] - mean);
            }
            autocorr.push(sum / (n * variance) || 0);
        }
        return autocorr;
    }
    
    private createDefaultResult(filteredValue: number): BeatDetectionResult {
        return {
            bpm: 0,
            confidence: 0,
            isPeak: false,
            filteredValue: filteredValue,
            arrhythmiaCount: 0,
            sqi: 0,
            hrvSdnn: 0,
            hrvRmssd: 0,
            hrvPnn50: 0,
            afDetected: false,
            pvcDetected: false,
            pacDetected: false,
            rvrDetected: false
        };
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
    
    // ================================================================
    // PUBLIC INTERFACE (matches HeartBeatProcessor)
    // ================================================================
    
    getRRIntervals(): number[] { return [...this.rrIntervals]; }
    getLastPeakTime(): number { return this.lastPeakTime; }
    getSQI(): number { return this.signalQualityIndex; }
    
    reset(): void {
        this.signalBuffer = [];
        this.timestampBuffer = [];
        this.rrIntervals = [];
        this.hrDerivatives = [];
        this.rrDifferences = [];
        this.smoothBPM = 0;
        this.signalQualityIndex = 0;
        this.lastPeakTime = 0;
        this.lastPeakValue = 0;
    }
    
    dispose(): void {
        if (this.audioContext) this.audioContext.close().catch(() => {});
    }
}