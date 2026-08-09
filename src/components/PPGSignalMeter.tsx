import React, { useEffect, useRef, useCallback } from 'react';
import { CircularBuffer, PPGDataPoint } from '../utils/CircularBuffer';

interface PPGSignalMeterProps {
  value: number;
  quality: number;
  isFingerDetected: boolean;
  onStartMeasurement: () => void;
  onReset: () => void;
  isMonitoring?: boolean;
  arrhythmiaStatus?: string;
  rawArrhythmiaData?: {
    timestamp: number;
    rmssd: number;
    rrVariation: number;
  } | null;
  preserveResults?: boolean;
  diagnosticMessage?: string;
  isPeak?: boolean;
  bpm?: number;
  spo2?: number;
  rrIntervals?: number[];
  elapsedTime?: number;
  perfusionIndex?: number;
  pressure?: { systolic: number; diastolic: number; confidence?: string; featureQuality?: number };
}

const CONFIG = {
  CANVAS_WIDTH: 840,
  CANVAS_HEIGHT: 1680,
  WINDOW_MS: 3200,
  TARGET_FPS: 60,
  BUFFER_SIZE: 600,
  FONT: '"SF Mono", "Consolas", "Monaco", monospace',
  SWEEP_SPEED_PX_PER_SEC: 150,
  SIGNAL_COLOR: '#00ff88',
  SIGNAL_GLOW: 'rgba(0, 255, 136, 0.6)',
  SIGNAL_ARRHYTHMIA: '#ff3344',
  ARRHYTHMIA_GLOW: 'rgba(255, 51, 68, 0.6)',
  BG_COLOR: '#000a05',
  GRID_MAJOR: 'rgba(0, 255, 136, 0.08)',
  GRID_MINOR: 'rgba(0, 255, 136, 0.03)',
  BASELINE_COLOR: 'rgba(0, 255, 136, 0.22)',
  PEAK_POSITIVE_COLOR: '#00ff88',
  PEAK_NEGATIVE_COLOR: '#4df0ff',
  ANATOMY_LINE_WIDTH: 2.4,
};

const DEG = Math.PI / 180;

const pitchYaw = (now: number) => {
  const pitch = (34 + 2.2 * Math.sin(now / 9400)) * DEG;
  const yaw = 2.4 * Math.sin(now / 12600 + 1.7) * DEG;
  const cth = Math.cos(pitch);
  const sth = Math.sin(pitch);
  const cph = Math.cos(yaw);
  const sph = Math.sin(yaw);
  return { cth, sth, cph, sph, H: 700, D: 2600, F: 2350, cx: 420, cy: 700 };
};

const project = (x: number, y: number, z: number, cam: ReturnType<typeof pitchYaw>) => {
  const zr = -x * cam.sph + z * cam.cph;
  const xr = x * cam.cph + z * cam.sph;
  const yw = y - cam.H;
  const y1 = yw * cam.cth - zr * cam.sth;
  const z2 = yw * cam.sth + zr * cam.cth;
  const zc = cam.D - z2;
  const inv = cam.F / zc;
  return { sx: cam.cx + xr * inv, sy: cam.cy - y1 * inv, zc };
};

const cardiacModel = (t: number) => {
  const cycle = t % 1;
  let y = 0;
  let tag: 'p' | 'q' | 'r' | 's' | 't' | 'baseline' = 'baseline';

  if (cycle < 0.08) {
    y = 0.18 * Math.sin((cycle / 0.08) * Math.PI);
    tag = 'p';
  } else if (cycle < 0.12) {
    const k = (cycle - 0.08) / 0.04;
    y = 0.18 * (1 - k) - 0.22 * k;
    tag = 'q';
  } else if (cycle < 0.18) {
    const k = (cycle - 0.12) / 0.06;
    y = -0.22 + 1.18 * Math.sin(k * Math.PI);
    tag = 'r';
  } else if (cycle < 0.24) {
    const k = (cycle - 0.18) / 0.06;
    y = 0.96 - 0.34 * Math.sin(k * Math.PI);
    tag = 's';
  } else if (cycle < 0.38) {
    const k = (cycle - 0.24) / 0.14;
    y = 0.28 * Math.sin(k * Math.PI);
    tag = 't';
  } else {
    y = 0;
    tag = 'baseline';
  }
  return { y, tag };
};

const beatAnnotations = (rrMs: number | undefined, bpm: number, arrStatus?: string) => {
  const arrhythmia = !!arrStatus && arrStatus.includes('AF');
  const pvc = !!arrStatus && arrStatus.includes('PVC');
  const pac = !!arrStatus && arrStatus.includes('PAC');
  const rvr = bpm > 140;
  const brady = bpm > 0 && bpm < 60;
  const tachy = bpm > 100;
  const rrLabel = rrMs && rrMs > 0 ? `${Math.round(rrMs)} ms` : '-- ms';
  let label = 'NSR';
  if (arrhythmia) label = 'AF';
  else if (pvc) label = 'PVC';
  else if (pac) label = 'PAC';
  else if (rvr) label = 'RVR';
  else if (brady) label = 'BRADY';
  else if (tachy) label = 'TACHY';
  return { label, rrLabel };
};

const PPGSignalMeter = ({
  value,
  quality,
  isFingerDetected,
  onStartMeasurement,
  onReset,
  isMonitoring = false,
  arrhythmiaStatus,
  rawArrhythmiaData,
  preserveResults = false,
  diagnosticMessage,
  isPeak = false,
  bpm = 0,
  spo2 = 0,
  rrIntervals = [],
  elapsedTime = 0,
  perfusionIndex = 0,
  pressure,
}: PPGSignalMeterProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const isRunningRef = useRef(false);
  const dataBufferRef = useRef<CircularBuffer | null>(null);

  const propsRef = useRef({
    value,
    quality,
    isFingerDetected,
    arrhythmiaStatus,
    preserveResults,
    isPeak,
    bpm,
    spo2,
    rrIntervals,
    rawArrhythmiaData,
    elapsedTime,
    perfusionIndex,
    pressure,
  });

  const beatFlashRef = useRef({ time: 0, age: Infinity });
  const beatHistoryRef = useRef<{ isArrhythmia: boolean; time: number }[]>([]);
  const amplitudeStatsRef = useRef({ min: -50, max: 50, range: 100 });

  const ibiDisplayRef = useRef<number>(0);
  const hrvDisplayRef = useRef<{ sdnn: number; rmssd: number }>({ sdnn: 0, rmssd: 0 });
  const bpmStatsRef = useRef<{ min: number; max: number; sum: number; n: number }>({ min: 0, max: 0, sum: 0, n: 0 });
  const bpmTrendRef = useRef<{ t: number; bpm: number }[]>([]);
  const lastHrvUpdateRef = useRef<number>(0);
  const lastBpmStatsUpdateRef = useRef<number>(0);

  const bgCacheRef = useRef<HTMLCanvasElement | null>(null);
  const sweepPosRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const signalPathRef = useRef<{ x: number; y: number }[]>([]);
  const prevYRef = useRef(0);

  useEffect(() => {
    propsRef.current = { value, quality, isFingerDetected, arrhythmiaStatus, preserveResults, isPeak, bpm, spo2, rrIntervals, rawArrhythmiaData, elapsedTime, perfusionIndex, pressure };

    const now = Date.now();

    if (now - lastHrvUpdateRef.current > 500 && rrIntervals && rrIntervals.length >= 2) {
      lastHrvUpdateRef.current = now;
      const last = rrIntervals[rrIntervals.length - 1];
      ibiDisplayRef.current = Math.round(last);

      const mean = rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length;
      const variance = rrIntervals.reduce((sum, rr) => sum + (rr - mean) ** 2, 0) / rrIntervals.length;
      hrvDisplayRef.current.sdnn = Math.round(Math.sqrt(variance));

      let sumSqDiffs = 0;
      for (let i = 1; i < rrIntervals.length; i++) {
        sumSqDiffs += (rrIntervals[i] - rrIntervals[i - 1]) ** 2;
      }
      hrvDisplayRef.current.rmssd = Math.round(Math.sqrt(sumSqDiffs / (rrIntervals.length - 1)));
    }

    if (bpm > 30 && bpm < 220 && now - lastBpmStatsUpdateRef.current > 500) {
      lastBpmStatsUpdateRef.current = now;
      const s = bpmStatsRef.current;
      if (s.n === 0) { s.min = bpm; s.max = bpm; }
      else { if (bpm < s.min) s.min = bpm; if (bpm > s.max) s.max = bpm; }
      s.sum += bpm;
      s.n += 1;
      bpmTrendRef.current.push({ t: now, bpm });
      if (bpmTrendRef.current.length > 80) bpmTrendRef.current.shift();
    }
    if (!isFingerDetected && !preserveResults) {
      bpmStatsRef.current = { min: 0, max: 0, sum: 0, n: 0 };
      bpmTrendRef.current = [];
    }
  }, [value, quality, isFingerDetected, arrhythmiaStatus, preserveResults, isPeak, bpm, spo2, rrIntervals, rawArrhythmiaData, elapsedTime, perfusionIndex, pressure]);

  useEffect(() => {
    if (!dataBufferRef.current) {
      dataBufferRef.current = new CircularBuffer(CONFIG.BUFFER_SIZE);
    }
    return () => {
      isRunningRef.current = false;
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, []);

  useEffect(() => {
    if (preserveResults && !isFingerDetected) {
      dataBufferRef.current?.clear();
    }
  }, [preserveResults, isFingerDetected]);

  const drawBackground = useCallback((ctx: CanvasRenderingContext2D) => {
    const W = CONFIG.CANVAS_WIDTH;
    const H = CONFIG.CANVAS_HEIGHT;
    ctx.fillStyle = CONFIG.BG_COLOR;
    ctx.fillRect(0, 0, W, H);

    const bgGrad = ctx.createRadialGradient(W / 2, H * 0.36, 0, W / 2, H * 0.36, Math.max(W, H) / 1.05);
    bgGrad.addColorStop(0, '#0b1a10');
    bgGrad.addColorStop(0.5, '#050d08');
    bgGrad.addColorStop(1, CONFIG.BG_COLOR);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);
  }, []);

  const ensureBgCache = useCallback((ctx: CanvasRenderingContext2D) => {
    if (!bgCacheRef.current) {
      const offscreen = document.createElement('canvas');
      offscreen.width = CONFIG.CANVAS_WIDTH;
      offscreen.height = CONFIG.CANVAS_HEIGHT;
      const offCtx = offscreen.getContext('2d', { alpha: false })!;
      drawBackground(offCtx);
      bgCacheRef.current = offscreen;
    }
    ctx.drawImage(bgCacheRef.current, 0, 0);
  }, [drawBackground]);

  const drawECGGrid = useCallback((ctx: CanvasRenderingContext2D) => {
    const W = CONFIG.CANVAS_WIDTH;
    const H = CONFIG.CANVAS_HEIGHT;
    const stageY0 = 280;
    const stageY1 = 1220;
    const stageH = stageY1 - stageY0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, stageY0, W, stageH);
    ctx.clip();

    ctx.strokeStyle = CONFIG.GRID_MINOR;
    ctx.lineWidth = 0.5;
    const minorStep = 8;
    for (let y = stageY0; y <= stageY1; y += minorStep) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    for (let x = 0; x < W; x += minorStep) {
      ctx.beginPath();
      ctx.moveTo(x, stageY0);
      ctx.lineTo(x, stageY1);
      ctx.stroke();
    }

    ctx.strokeStyle = CONFIG.GRID_MAJOR;
    ctx.lineWidth = 0.8;
    const majorStep = 40;
    for (let y = stageY0; y <= stageY1; y += majorStep) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    for (let x = 0; x < W; x += majorStep) {
      ctx.beginPath();
      ctx.moveTo(x, stageY0);
      ctx.lineTo(x, stageY1);
      ctx.stroke();
    }

    ctx.strokeStyle = CONFIG.GRID_MAJOR;
    ctx.lineWidth = 1;
    const bigStep = 200;
    for (let y = stageY0; y <= stageY1; y += bigStep) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    for (let x = 0; x < W; x += bigStep) {
      ctx.beginPath();
      ctx.moveTo(x, stageY0);
      ctx.lineTo(x, stageY1);
      ctx.stroke();
    }

    ctx.restore();
  }, []);

  const drawHeader = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const W = CONFIG.CANVAS_WIDTH;
    const { quality, elapsedTime } = propsRef.current;

    ctx.font = `bold 11px ${CONFIG.FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = CONFIG.SIGNAL_COLOR;
    ctx.fillText('● CARDIAC MONITOR', 14, 22);

    ctx.font = `9px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.6)';
    ctx.fillText('ECG/PPG WAVEFORM · REAL-TIME', 14, 36);

    const recentBeat = now - beatFlashRef.current.time < 400;
    const hx = 220;
    ctx.font = `bold 18px ${CONFIG.FONT}`;
    ctx.fillStyle = recentBeat ? '#ff6b6b' : CONFIG.SIGNAL_COLOR;
    ctx.textAlign = 'center';
    if (recentBeat && propsRef.current.isFingerDetected) {
      const p = 1 - (now - beatFlashRef.current.time) / 400;
      ctx.save();
      ctx.shadowColor = 'rgba(255, 80, 80, 0.9)';
      ctx.shadowBlur = 10 + 24 * p;
      ctx.scale(1 + 0.18 * p, 1 + 0.18 * p);
      ctx.fillText('♥', hx / (1 + 0.18 * p), 30);
      ctx.restore();
    } else {
      ctx.save();
      ctx.shadowColor = 'rgba(255, 80, 80, 0.6)';
      ctx.shadowBlur = 8;
      ctx.fillText('♥', hx, 30);
      ctx.restore();
    }
    ctx.font = `9px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.6)';
    ctx.textAlign = 'left';
    ctx.fillText('LIVE', hx + 18, 30);

    const cxc = W / 2;
    const bw = 150;
    ctx.textAlign = 'center';
    ctx.font = `9px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.5)';
    ctx.fillText('SIGNAL QUALITY', cxc, 14);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(cxc - bw / 2, 20, bw, 8);
    const qGrad = ctx.createLinearGradient(cxc - bw / 2, 0, cxc - bw / 2 + bw, 0);
    if (quality > 60) { qGrad.addColorStop(0, '#166534'); qGrad.addColorStop(1, CONFIG.SIGNAL_COLOR); }
    else if (quality > 30) { qGrad.addColorStop(0, '#854d0e'); qGrad.addColorStop(1, '#fbbf24'); }
    else { qGrad.addColorStop(0, '#7f1d1d'); qGrad.addColorStop(1, '#ff5d5d'); }
    ctx.fillStyle = qGrad;
    ctx.fillRect(cxc - bw / 2, 20, bw * Math.min(1, quality / 100), 8);
    ctx.font = `bold 10px ${CONFIG.FONT}`;
    ctx.fillStyle = quality > 60 ? CONFIG.SIGNAL_COLOR : quality > 30 ? '#fbbf24' : '#ff5d5d';
    ctx.fillText(`${quality.toFixed(0)}%`, cxc + bw / 2 + 24, 28);

    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const t = Math.max(0, Math.floor(elapsedTime || 0));
    const em = String(Math.floor(t / 60)).padStart(2, '0');
    const es = String(t % 60).padStart(2, '0');
    ctx.textAlign = 'right';
    ctx.font = `bold 12px ${CONFIG.FONT}`;
    ctx.fillStyle = CONFIG.SIGNAL_COLOR;
    ctx.fillText(`⏱ ${em}:${es}`, W - 14, 22);
    ctx.font = `9px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.6)';
    ctx.fillText(`${hh}:${mm}:${ss}`, W - 14, 36);
  }, []);

  const drawMetricsRow = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const W = CONFIG.CANVAS_WIDTH;
    const { bpm, spo2, perfusionIndex, pressure, rrIntervals } = propsRef.current;

    const y = 52;
    const h = 200;
    const gap = 10;
    const cardW = (W - gap * 5) / 4;
    const xs = [gap, gap * 2 + cardW, gap * 3 + cardW * 2, gap * 4 + cardW * 3];

    ctx.save();
    for (let i = 0; i < 4; i++) {
      const x = xs[i];
      ctx.fillStyle = 'rgba(0, 10, 5, 0.85)';
      ctx.fillRect(x, y, cardW, h);
      ctx.strokeStyle = 'rgba(0, 255, 136, 0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, cardW, h);
      ctx.fillStyle = 'rgba(0, 255, 136, 0.5)';
      ctx.fillRect(x, y, cardW, 2);
    }
    ctx.restore();

    const hrCard = xs[0];
    const hrAlarm = bpm > 0 && (bpm < 60 || bpm > 100);
    ctx.font = `bold 9px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.6)';
    ctx.textAlign = 'left';
    ctx.fillText('HEART RATE', hrCard + 12, y + 18);

    const beatAge = now - beatFlashRef.current.time;
    const beatPulse = propsRef.current.isFingerDetected && beatAge < 450 ? (1 - beatAge / 450) : 0;
    const valSize = 52 + 8 * beatPulse;
    ctx.font = `bold ${valSize}px ${CONFIG.FONT}`;
    ctx.fillStyle = bpm > 0 ? CONFIG.SIGNAL_COLOR : 'rgba(0, 255, 136, 0.3)';
    ctx.textAlign = 'left';
    ctx.save();
    if (bpm > 0) {
      ctx.shadowColor = `rgba(0, 255, 136, ${0.35 + 0.5 * beatPulse})`;
      ctx.shadowBlur = 14 + 26 * beatPulse;
    }
    ctx.fillText(bpm > 0 ? bpm.toString() : '--', hrCard + 12, y + 78);
    ctx.restore();
    ctx.font = `bold 11px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.5)';
    ctx.textAlign = 'right';
    ctx.fillText('BPM', hrCard + cardW - 12, y + 68);
    if (bpm > 0) {
      let label = '';
      let color = CONFIG.SIGNAL_COLOR;
      if (bpm < 60) { label = 'BRADICARDIA'; color = '#fbbf24'; }
      else if (bpm <= 100) { label = 'NORMAL'; color = CONFIG.SIGNAL_COLOR; }
      else { label = 'TAQUICARDIA'; color = '#fbbf24'; }
      ctx.font = `bold 9px ${CONFIG.FONT}`;
      ctx.fillStyle = color;
      ctx.fillText(label, hrCard + 12, y + 100);
    }
    ctx.font = `8px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.4)';
    ctx.fillText('RANGE 60-100', hrCard + 12, y + 180);

    const spCard = xs[1];
    const spBorder = spo2 >= 95 ? CONFIG.SIGNAL_COLOR : spo2 >= 90 ? '#fbbf24' : spo2 > 0 ? '#ff5d5d' : 'rgba(0, 255, 136, 0.3)';
    ctx.font = `bold 9px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(77, 215, 254, 0.6)';
    ctx.textAlign = 'left';
    ctx.fillText('SpO₂', spCard + 12, y + 18);
    ctx.font = `bold 52px ${CONFIG.FONT}`;
    ctx.fillStyle = spBorder;
    ctx.textAlign = 'left';
    ctx.save();
    if (spo2 > 0) {
      ctx.shadowColor = 'rgba(77, 215, 254, 0.4)';
      ctx.shadowBlur = 12;
    }
    ctx.fillText(spo2 > 0 ? spo2.toFixed(0) : '--', spCard + 12, y + 78);
    ctx.restore();
    ctx.font = `bold 11px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(77, 215, 254, 0.5)';
    ctx.textAlign = 'right';
    ctx.fillText('%', spCard + cardW - 12, y + 68);
    if (spo2 > 0) {
      let label = '';
      let color = CONFIG.SIGNAL_COLOR;
      if (spo2 >= 95) { label = 'NORMAL'; color = CONFIG.SIGNAL_COLOR; }
      else if (spo2 >= 90) { label = 'LOW'; color = '#fbbf24'; }
      else { label = 'CRITICAL'; color = '#ff5d5d'; }
      ctx.font = `bold 9px ${CONFIG.FONT}`;
      ctx.fillStyle = color;
      ctx.fillText(label, spCard + 12, y + 100);
    }
    ctx.font = `8px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(77, 215, 254, 0.4)';
    ctx.fillText('TARGET ≥ 95%', spCard + 12, y + 180);

    const mpCard = xs[2];
    const sys = pressure?.systolic || 0;
    const dia = pressure?.diastolic || 0;
    const map = sys > 0 && dia > 0 ? Math.round(dia + (sys - dia) / 3) : 0;
    const mpBorder = map === 0 ? 'rgba(0, 255, 136, 0.3)' : (map < 65 || map > 110) ? '#fbbf24' : CONFIG.SIGNAL_COLOR;
    ctx.font = `bold 9px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(129, 140, 248, 0.6)';
    ctx.textAlign = 'left';
    ctx.fillText('NIBP', mpCard + 12, y + 18);
    ctx.font = `bold 52px ${CONFIG.FONT}`;
    ctx.fillStyle = mpBorder;
    ctx.textAlign = 'left';
    ctx.save();
    if (map > 0) {
      ctx.shadowColor = 'rgba(129, 140, 248, 0.4)';
      ctx.shadowBlur = 12;
    }
    ctx.fillText(map > 0 ? `${map}` : '--', mpCard + 12, y + 78);
    ctx.restore();
    ctx.font = `bold 11px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(129, 140, 248, 0.5)';
    ctx.textAlign = 'right';
    ctx.fillText('mmHg', mpCard + cardW - 12, y + 68);
    ctx.font = `bold 10px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(129, 140, 248, 0.5)';
    ctx.fillText(sys > 0 ? `${sys}/${dia}` : '--/--', mpCard + 12, y + 100);
    ctx.font = `8px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(129, 140, 248, 0.4)';
    ctx.fillText('MAP 70-105', mpCard + 12, y + 180);

    const piCard = xs[3];
    const piVal = perfusionIndex || 0;
    const piBorder = piVal >= 0.02 ? CONFIG.SIGNAL_COLOR : piVal >= 0.005 ? '#fbbf24' : '#ff5d5d';
    ctx.font = `bold 9px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(251, 191, 36, 0.6)';
    ctx.textAlign = 'left';
    ctx.fillText('PERFUSION', piCard + 12, y + 18);
    ctx.font = `bold 52px ${CONFIG.FONT}`;
    ctx.fillStyle = piBorder;
    ctx.textAlign = 'left';
    ctx.fillText(piVal > 0 ? (piVal * 100).toFixed(1) : '--', piCard + 12, y + 78);
    ctx.font = `bold 11px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(251, 191, 36, 0.5)';
    ctx.textAlign = 'right';
    ctx.fillText('%', piCard + cardW - 12, y + 68);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(piCard + 12, y + 92, cardW - 24, 6);
    const piPct = Math.min(1, piVal / 0.05);
    ctx.fillStyle = piBorder;
    ctx.fillRect(piCard + 12, y + 92, (cardW - 24) * piPct, 6);
    ctx.font = `8px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(251, 191, 36, 0.4)';
    ctx.fillText('PI ≥ 2%', piCard + 12, y + 180);
  }, []);

  const draw3DStage = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const { preserveResults, isFingerDetected: detected, value: signalValue, isPeak: peak, arrhythmiaStatus: arrStatus, bpm, rrIntervals } = propsRef.current;
    const stage = { x0: 58, x1: 782, y0: 268, y1: 1260 };
    const stageW = stage.x1 - stage.x0;
    const stageH = stage.y1 - stage.y0;
    const centerY = (stage.y0 + stage.y1) / 2;
    const cam = pitchYaw(now);

    ctx.save();
    ctx.beginPath();
    ctx.rect(stage.x0, stage.y0, stage.x1 - stage.x0, stage.y1 - stage.y0);
    ctx.clip();

    const plBackL = project(-420, 0, -900, cam);
    const plBackR = project(420, 0, -900, cam);
    const plFrontL = project(-420, 0, 0, cam);
    const plFrontR = project(420, 0, 0, cam);
    const planeGrad = ctx.createLinearGradient(0, plBackL.sy, 0, plFrontL.sy);
    planeGrad.addColorStop(0, 'rgba(0, 15, 8, 0.3)');
    planeGrad.addColorStop(1, 'rgba(0, 25, 15, 0.5)');
    ctx.fillStyle = planeGrad;
    ctx.beginPath();
    ctx.moveTo(plBackL.sx, plBackL.sy);
    ctx.lineTo(plBackR.sx, plBackR.sy);
    ctx.lineTo(plFrontR.sx, plFrontR.sy);
    ctx.lineTo(plFrontL.sx, plFrontL.sy);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(0, 255, 136, 0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const x = -420 + (i / 10) * 840;
      const a = project(x, 0, -900, cam);
      const b = project(x, 0, 0, cam);
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }
    for (let i = 0; i <= 8; i++) {
      const z = -900 + (i / 8) * 900;
      const a = project(-420, 0, z, cam);
      const b = project(420, 0, z, cam);
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(0, 255, 136, 0.2)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(plFrontL.sx, plFrontL.sy);
    ctx.lineTo(plFrontR.sx, plFrontR.sy);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0, 255, 136, 0.08)';
    ctx.beginPath();
    ctx.moveTo(plBackL.sx, plBackL.sy);
    ctx.lineTo(plBackR.sx, plBackR.sy);
    ctx.stroke();

    for (let s = 0; s <= 2.8; s += 0.5) {
      const x = -380 + (s / 2.8) * 760;
      const a = project(x, 0, -380, cam);
      const b = project(x, 20, -380, cam);
      ctx.strokeStyle = 'rgba(77, 215, 254, 0.20)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
      if (s === Math.round(s)) {
        ctx.font = `9px ${CONFIG.FONT}`;
        ctx.fillStyle = 'rgba(0, 255, 136, 0.3)';
        ctx.textAlign = 'center';
        ctx.fillText(`${s}s`, a.sx, a.sy - 8);
      }
    }

    const hasWave = !(preserveResults && !detected);
    if (!hasWave) {
      ctx.restore();
      return;
    }

    const scaledValue = signalValue * 2;

    if (peak) {
      beatFlashRef.current = { time: now, age: 0 };
      const currentCount = arrStatus ? parseInt(arrStatus.split('|')[1] || '0') : 0;
      const isArr = currentCount > (parseInt(arrStatus?.split('|')[1] || '0') > 0 ? 1 : 0);
      beatHistoryRef.current.push({ isArrhythmia: isArr, time: now });
      if (beatHistoryRef.current.length > 20) {
        beatHistoryRef.current = beatHistoryRef.current.slice(-20);
      }
    }

    const buffer = dataBufferRef.current;
    if (buffer) {
      buffer.push({ time: now, value: scaledValue, isArrhythmia: false });
    }

    const points = buffer?.getPoints() || [];
    if (points.length > 30) {
      let min = Infinity;
      let max = -Infinity;
      const recentPoints = points.length > 150 ? points.slice(-150) : points;
      for (let i = 0; i < recentPoints.length; i++) {
        const v = recentPoints[i].value;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const range = Math.max(40, max - min);
      const stats = amplitudeStatsRef.current;
      stats.min = stats.min * 0.95 + (min - range * 0.1) * 0.05;
      stats.max = stats.max * 0.95 + (max + range * 0.1) * 0.05;
      stats.range = stats.max - stats.min;
    }

    const stats = amplitudeStatsRef.current;
    const beatAge = now - beatFlashRef.current.time;
    const beatPulse = Math.exp(-Math.max(0, beatAge) / 320);
    const ampBoost = 1 + 0.06 * beatPulse;
    const waveBright = 0.72 + 0.28 * beatPulse;

    const proj3: { sx: number; sy: number; syPlane: number; isArr: boolean; x: number; y: number; zc: number; tag: string }[] = [];
    const pointsList = points.length > 400 ? points.slice(-400) : points;

    const rrSample = rrIntervals && rrIntervals.length > 0 ? rrIntervals[rrIntervals.length - 1] : undefined;
    const { label: rhythmLabel } = beatAnnotations(rrSample, bpm, arrStatus);

    for (let i = 0; i < pointsList.length; i++) {
      const pt = pointsList[i];
      const age = now - pt.time;
      if (age > CONFIG.WINDOW_MS) continue;
      const x = -380 + ((CONFIG.WINDOW_MS - age) / CONFIG.WINDOW_MS) * 760;
      const z = -380 + (age / CONFIG.WINDOW_MS) * 130;
      const phase = ((CONFIG.WINDOW_MS - age) / CONFIG.WINDOW_MS);
      const modeled = cardiacModel(phase);
      const normalizedY = (stats.max - pt.value) / stats.range;
      const worldY = (normalizedY - 0.5) * 1520 * ampBoost;
      const p = project(x, worldY, z, cam);
      const pp = project(x, 0, z, cam);
      proj3.push({ sx: p.sx, sy: p.sy, syPlane: pp.sy, isArr: pt.isArrhythmia, x, y: worldY, zc: p.zc, tag: modeled.tag });
    }

    if (proj3.length > 2) {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.strokeStyle = CONFIG.SIGNAL_COLOR;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let mstarted = false;
      for (const c of proj3) {
        const m = project(c.x, -c.y * 0.5, -380, cam);
        if (!mstarted) { ctx.moveTo(m.sx, m.sy); mstarted = true; }
        else ctx.lineTo(m.sx, m.sy);
      }
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.moveTo(proj3[0].sx, proj3[0].sy);
      for (const c of proj3) ctx.lineTo(c.sx, c.sy);
      for (let i = proj3.length - 1; i >= 0; i--) ctx.lineTo(proj3[i].sx, proj3[i].syPlane);
      ctx.closePath();
      const ribbonGrad = ctx.createLinearGradient(0, Math.min(...proj3.map(c => c.sy)) - 20, 0, Math.max(...proj3.map(c => c.syPlane)) + 20);
      ribbonGrad.addColorStop(0, 'rgba(0, 255, 136, 0.12)');
      ribbonGrad.addColorStop(0.5, 'rgba(0, 255, 136, 0.04)');
      ribbonGrad.addColorStop(1, 'rgba(0, 255, 136, 0.0)');
      ctx.fillStyle = ribbonGrad;
      ctx.fill();

      const runs: { pts: { sx: number; sy: number; syPlane: number }[]; arr: boolean }[] = [];
      let currentRun: { sx: number; sy: number; syPlane: number }[] = [];
      let currentArr = proj3[0].isArr;
      for (const c of proj3) {
        if (c.isArr === currentArr) {
          currentRun.push({ sx: c.sx, sy: c.sy, syPlane: c.syPlane });
        } else {
          if (currentRun.length > 1) runs.push({ pts: currentRun, arr: currentArr });
          currentRun = [{ sx: c.sx, sy: c.sy, syPlane: c.syPlane }];
          currentArr = c.isArr;
        }
      }
      if (currentRun.length > 1) runs.push({ pts: currentRun, arr: currentArr });

      ctx.strokeStyle = 'rgba(0, 255, 136, 0.10)';
      ctx.lineWidth = 1;
      for (let i = 0; i < proj3.length; i += 3) {
        const c = proj3[i];
        ctx.beginPath();
        ctx.moveTo(c.sx, c.sy);
        ctx.lineTo(c.sx, c.syPlane);
        ctx.stroke();
      }

      for (const run of runs) {
        if (!run.arr) continue;
        ctx.beginPath();
        ctx.moveTo(run.pts[0].sx, run.pts[0].sy);
        for (const c of run.pts) ctx.lineTo(c.sx, c.sy);
        for (let i = run.pts.length - 1; i >= 0; i--) ctx.lineTo(run.pts[i].sx, run.pts[i].syPlane);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 51, 68, 0.08)';
        ctx.fill();
      }

      const strokePass = (arr: boolean, width: number, alpha: number, blur: number, useCore = false) => {
        ctx.save();
        ctx.globalAlpha = alpha * waveBright;
        for (const run of runs) {
          if (run.arr !== arr) continue;
          ctx.beginPath();
          ctx.moveTo(run.pts[0].sx, run.pts[0].sy);
          for (let i = 1; i < run.pts.length; i++) ctx.lineTo(run.pts[i].sx, run.pts[i].sy);
          if (blur > 0) {
            ctx.shadowColor = arr ? CONFIG.ARRHYTHMIA_GLOW : CONFIG.SIGNAL_GLOW;
            ctx.shadowBlur = blur;
          }
          ctx.strokeStyle = arr ? (useCore ? '#ffd9d9' : CONFIG.SIGNAL_ARRHYTHMIA) : (useCore ? '#ffffff' : CONFIG.SIGNAL_COLOR);
          ctx.lineWidth = width;
          ctx.stroke();
        }
        ctx.restore();
      };

      strokePass(false, 8, 0.15, 20);
      strokePass(true, 8, 0.15, 20);
      strokePass(false, 2.5, 0.9, 10);
      strokePass(true, 2.5, 0.9, 10);
      strokePass(false, 1, 1, 0, true);
      strokePass(true, 1, 1, 0, true);

      ctx.save();
      ctx.globalAlpha = 0.85 * waveBright;
      ctx.strokeStyle = CONFIG.BASELINE_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      let started = false;
      for (const c of proj3) {
        const base = project(c.x, 0, -380, cam);
        if (!started) { ctx.moveTo(base.sx, base.sy); started = true; }
        else ctx.lineTo(base.sx, base.sy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      const last = proj3[proj3.length - 1];
      const beamTop = project(last.x, 1300, -380, cam);
      const beamBottom = project(last.x, -1000, -380, cam);
      const beamGrad = ctx.createLinearGradient(beamTop.sx - 70, 0, beamTop.sx + 6, 0);
      const beamPulse = 0.14 + 0.08 * Math.sin(now / 240) + 0.10 * beatPulse;
      beamGrad.addColorStop(0, 'rgba(0, 255, 136, 0)');
      beamGrad.addColorStop(1, `rgba(0, 255, 136, ${beamPulse})`);
      ctx.fillStyle = beamGrad;
      const btop = Math.min(beamTop.sy, beamBottom.sy);
      const bheight = Math.abs(beamBottom.sy - beamTop.sy);
      ctx.fillRect(beamTop.sx - 70, btop, 76, bheight);
      ctx.save();
      ctx.shadowColor = 'rgba(0, 255, 136, 0.9)';
      ctx.shadowBlur = 12;
      ctx.fillStyle = `rgba(0, 255, 136, ${0.35 + 0.2 * beatPulse})`;
      ctx.fillRect(beamTop.sx - 1.5, btop, 1.5, bheight);
      ctx.restore();

      ctx.save();
      ctx.font = `bold 9px ${CONFIG.FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.textAlign = 'left';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 6;
      ctx.fillText(`RHYTHM ${rhythmLabel}`, last.sx + 8, last.sy - 14);
      ctx.restore();
    }
    ctx.restore();
  }, []);

  const drawAnalyticsBand = useCallback((ctx: CanvasRenderingContext2D) => {
    const W = CONFIG.CANVAS_WIDTH;
    const { rrIntervals, bpm, spo2 } = propsRef.current;

    const y = 1264;
    const h = 320;
    const gap = 10;
    const w = (W - gap * 3) / 2;

    ctx.save();
    for (let i = 0; i < 2; i++) {
      const x = i === 0 ? gap : gap * 2 + w;
      ctx.fillStyle = 'rgba(0, 10, 5, 0.85)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(0, 255, 136, 0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = 'rgba(0, 255, 136, 0.5)';
      ctx.fillRect(x, y, w, 2);
    }
    ctx.restore();

    const tx = gap;
    ctx.font = `bold 9px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.6)';
    ctx.textAlign = 'left';
    ctx.fillText('HRV ANALYSIS', tx + 14, y + 18);

    const trend = bpmTrendRef.current;
    if (trend.length >= 2) {
      let minB = trend[0].bpm;
      let maxB = trend[0].bpm;
      for (let i = 1; i < trend.length; i++) {
        if (trend[i].bpm < minB) minB = trend[i].bpm;
        if (trend[i].bpm > maxB) maxB = trend[i].bpm;
      }
      const range = Math.max(10, maxB - minB);
      ctx.beginPath();
      ctx.strokeStyle = CONFIG.SIGNAL_COLOR;
      ctx.lineWidth = 1.8;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 255, 136, 0.45)';
      ctx.shadowBlur = 8;
      const plotW = w - 28;
      for (let i = 0; i < trend.length; i++) {
        const p = trend[i];
        const px = tx + 14 + (i / (trend.length - 1)) * plotW;
        const py = y + 118 - ((p.bpm - minB) / range) * 90;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
      ctx.font = `8px ${CONFIG.FONT}`;
      ctx.fillStyle = 'rgba(0, 255, 136, 0.5)';
      ctx.textAlign = 'left';
      ctx.fillText(`MIN ${Math.round(minB)}`, tx + 14, y + 46);
      ctx.textAlign = 'right';
      ctx.fillText(`MAX ${Math.round(maxB)}`, tx + w - 14, y + 46);
    } else {
      ctx.font = `10px ${CONFIG.FONT}`;
      ctx.fillStyle = 'rgba(0, 255, 136, 0.3)';
      ctx.textAlign = 'center';
      ctx.fillText('ACCUMULATING DATA...', tx + w / 2, y + 90);
    }
    ctx.strokeStyle = 'rgba(0, 255, 136, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tx + 10, y + 132);
    ctx.lineTo(tx + w - 10, y + 132);
    ctx.stroke();

    ctx.font = `8px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.5)';
    ctx.fillText('HRV METRICS', tx + 14, y + 150);

    const hrv = hrvDisplayRef.current;
    const ibi = ibiDisplayRef.current;
    const meanRR = rrIntervals && rrIntervals.length > 0
      ? Math.round(rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length)
      : 0;
    ctx.font = `bold 28px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(103, 232, 249, 0.9)';
    ctx.textAlign = 'left';
    ctx.fillText(ibi > 0 ? `${ibi}` : '--', tx + 14, y + 188);
    ctx.font = `9px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(103, 232, 249, 0.5)';
    ctx.fillText('ms IBI', tx + (ibi > 0 ? 80 : 50), y + 188);
    ctx.font = `10px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.5)';
    ctx.fillText(`SDNN ${hrv.sdnn > 0 ? hrv.sdnn + 'ms' : '--'}`, tx + 14, y + 216);
    ctx.fillText(`RMSSD ${hrv.rmssd > 0 ? hrv.rmssd + 'ms' : '--'}`, tx + 14, y + 236);
    ctx.fillStyle = 'rgba(103, 232, 249, 0.5)';
    ctx.fillText(`MEAN RR ${meanRR > 0 ? meanRR + 'ms' : '--'}`, tx + 14, y + 256);
    const stats = bpmStatsRef.current;
    const meanBpm = stats.n > 0 ? Math.round(stats.sum / stats.n) : 0;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.5)';
    ctx.fillText(`AVG HR ${meanBpm || '--'} bpm`, tx + 14, y + 276);

    const rx = gap * 2 + w;
    ctx.font = `bold 9px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(77, 215, 254, 0.6)';
    ctx.textAlign = 'left';
    ctx.fillText('RR INTERVALS', rx + 14, y + 18);

    if (rrIntervals && rrIntervals.length >= 2) {
      const rrRecent = rrIntervals.slice(-60);
      let rrMin = Infinity;
      let rrMax = -Infinity;
      for (const v of rrRecent) {
        if (v < rrMin) rrMin = v;
        if (v > rrMax) rrMax = v;
      }
      const rrRange = Math.max(80, rrMax - rrMin);
      const px0 = rx + 14;
      const py0 = y + 34;
      const pw = w - 28;
      const ph = 84;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.fillRect(px0, py0, pw, ph);
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(77, 215, 254, 0.8)';
      ctx.lineWidth = 1.6;
      ctx.save();
      ctx.shadowColor = 'rgba(77, 215, 254, 0.4)';
      ctx.shadowBlur = 6;
      for (let i = 0; i < rrRecent.length; i++) {
        const px = px0 + 2 + (i / (rrRecent.length - 1)) * (pw - 4);
        const py = py0 + ph - 4 - ((rrRecent[i] - rrMin) / rrRange) * (ph - 8);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
      ctx.font = `8px ${CONFIG.FONT}`;
      ctx.fillStyle = 'rgba(77, 215, 254, 0.5)';
      ctx.textAlign = 'left';
      ctx.fillText(`${Math.round(rrMin)}ms`, px0 + 2, py0 + ph - 8);
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(rrMax)}ms`, px0 + pw - 2, py0 + 12);
    }

    ctx.strokeStyle = 'rgba(0, 255, 136, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx + 10, y + 132);
    ctx.lineTo(rx + w - 10, y + 132);
    ctx.stroke();

    ctx.font = `8px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.5)';
    ctx.fillText('BEAT HISTORY', rx + 14, y + 150);
    const beatHistory = beatHistoryRef.current;
    const arrCount = beatHistory.filter(b => b.isArrhythmia).length;
    const normalCount = beatHistory.length - arrCount;
    ctx.textAlign = 'right';
    ctx.fillStyle = CONFIG.SIGNAL_COLOR;
    ctx.fillText(`N:${normalCount}`, rx + w - 14, y + 150);
    ctx.fillStyle = arrCount > 0 ? CONFIG.SIGNAL_ARRHYTHMIA : 'rgba(0, 255, 136, 0.3)';
    ctx.fillText(` A:${arrCount}`, rx + w - 60, y + 150);

    const dotSpacing = 22;
    const totalWidth = beatHistory.length * dotSpacing;
    const startX = rx + w / 2 - totalWidth / 2;
    const cy = y + 210;
    for (let i = 0; i < beatHistory.length; i++) {
      const beat = beatHistory[i];
      const cx = startX + i * dotSpacing + dotSpacing / 2;
      if (beat.isArrhythmia) {
        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 51, 68, 0.2)';
        ctx.fill();
      }
      const dg = ctx.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, 7);
      dg.addColorStop(0, '#ffffff');
      dg.addColorStop(0.4, beat.isArrhythmia ? CONFIG.SIGNAL_ARRHYTHMIA : CONFIG.SIGNAL_COLOR);
      dg.addColorStop(1, beat.isArrhythmia ? '#7f1d1d' : '#0f5132');
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.fillStyle = dg;
      ctx.fill();
      ctx.font = `bold 7px ${CONFIG.FONT}`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(`${i + 1}`, cx, cy + 3);
    }
    if (beatHistory.length === 0) {
      ctx.font = `10px ${CONFIG.FONT}`;
      ctx.fillStyle = 'rgba(0, 255, 136, 0.3)';
      ctx.textAlign = 'center';
      ctx.fillText('—', rx + w / 2, cy + 4);
    }

    ctx.strokeStyle = 'rgba(0, 255, 136, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx + 10, y + 240);
    ctx.lineTo(rx + w - 10, y + 240);
    ctx.stroke();
    ctx.font = `8px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.5)';
    ctx.fillText('LAST IBI', rx + 14, y + 262);
    if (rrIntervals && rrIntervals.length > 0) {
      const rrLast = rrIntervals.slice(-14);
      let mx = 0;
      for (const v of rrLast) if (v > mx) mx = v;
      const bx0 = rx + 14;
      const by0 = y + 286;
      const bW = (w - 28) / rrLast.length;
      for (let i = 0; i < rrLast.length; i++) {
        const bh = 14 + (rrLast[i] / Math.max(mx, 1)) * 16;
        const g = ctx.createLinearGradient(0, by0 - bh, 0, by0);
        g.addColorStop(0, 'rgba(77, 215, 254, 0.5)');
        g.addColorStop(1, 'rgba(77, 215, 254, 0.1)');
        ctx.fillStyle = g;
        ctx.fillRect(bx0 + i * bW + 2, by0 - bh, Math.max(2, bW - 4), bh);
      }
    }
  }, []);

  const drawFooter = useCallback((ctx: CanvasRenderingContext2D) => {
    const W = CONFIG.CANVAS_WIDTH;
    const { bpm, spo2 } = propsRef.current;

    ctx.font = `8px ${CONFIG.FONT}`;
    ctx.textAlign = 'left';
    const lx = 14;
    const ly = 1656;

    ctx.fillStyle = CONFIG.SIGNAL_COLOR;
    ctx.fillRect(lx, ly - 6, 15, 3);
    ctx.beginPath();
    ctx.arc(lx + 22, ly - 4, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0, 255, 136, 0.6)';
    ctx.fillText('Normal', lx + 30, ly);

    ctx.fillStyle = CONFIG.SIGNAL_ARRHYTHMIA;
    ctx.fillRect(lx + 100, ly - 6, 15, 3);
    ctx.beginPath();
    ctx.arc(lx + 122, ly - 4, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0, 255, 136, 0.6)';
    ctx.fillText('Arrhythmia', lx + 130, ly);

    ctx.beginPath();
    ctx.arc(lx + 220, ly - 4, 4, 0, Math.PI * 2);
    ctx.fillStyle = CONFIG.SIGNAL_COLOR;
    ctx.fill();
    ctx.fillStyle = 'rgba(0, 255, 136, 0.6)';
    ctx.fillText('Peak', lx + 230, ly);

    ctx.beginPath();
    ctx.moveTo(lx + 264, ly - 6);
    ctx.lineTo(lx + 260, ly);
    ctx.lineTo(lx + 268, ly);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 255, 136, 0.6)';
    ctx.fill();
    ctx.fillText('Valley', lx + 274, ly);

    ctx.fillStyle = 'rgba(103, 232, 249, 0.6)';
    ctx.fillRect(lx + 318, ly - 5, 12, 2);
    ctx.fillText('IBI', lx + 336, ly);

    ctx.fillStyle = 'rgba(0, 255, 136, 0.3)';
    ctx.fillText('SWEEP 25mm/s · FILTER 0.5-4Hz · SOURCE PPG', 420, ly);

    ctx.textAlign = 'right';
    const alarms: string[] = [];
    if (bpm > 0 && (bpm < 50 || bpm > 120)) alarms.push('HR!');
    if (spo2 > 0 && spo2 < 92) alarms.push('SpO₂!');
    const sys = propsRef.current.pressure?.systolic || 0;
    const dia = propsRef.current.pressure?.diastolic || 0;
    const map = sys > 0 && dia > 0 ? Math.round(dia + (sys - dia) / 3) : 0;
    if (map > 0 && (map < 65 || map > 110)) alarms.push('MAP!');
    if (alarms.length > 0) {
      const pulse = (Math.sin(Date.now() / 180) + 1) / 2;
      ctx.save();
      ctx.shadowColor = `rgba(255, 51, 68, ${0.3 + pulse * 0.6})`;
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#ff5d5d';
      ctx.fillText(`⚠ ALARMS: ${alarms.join(' ')}`, 826, ly);
      ctx.restore();
    } else {
      ctx.fillStyle = CONFIG.SIGNAL_COLOR;
      ctx.fillText('● NO ALARMS', 826, ly);
    }
  }, []);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const now = Date.now();

    ensureBgCache(ctx);
    drawECGGrid(ctx);
    drawHeader(ctx, now);
    drawMetricsRow(ctx, now);
    draw3DStage(ctx, now);
    drawAnalyticsBand(ctx);
    drawFooter(ctx);
  }, [ensureBgCache, drawECGGrid, drawHeader, drawMetricsRow, draw3DStage, drawAnalyticsBand, drawFooter]);

  useEffect(() => {
    if (isRunningRef.current) return;
    isRunningRef.current = true;

    const frameTime = 1000 / CONFIG.TARGET_FPS;
    let lastRenderTime = 0;

    const renderLoop = () => {
      if (!isRunningRef.current) return;

      const now = Date.now();
      if (now - lastRenderTime < frameTime) {
        animationRef.current = requestAnimationFrame(renderLoop);
        return;
      }
      lastRenderTime = now;

      render();
      animationRef.current = requestAnimationFrame(renderLoop);
    };

    animationRef.current = requestAnimationFrame(renderLoop);

    return () => {
      isRunningRef.current = false;
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [render]);

  const handleReset = useCallback(() => {
    dataBufferRef.current?.clear();
    amplitudeStatsRef.current = { min: -50, max: 50, range: 100 };
    beatHistoryRef.current = [];
    ibiDisplayRef.current = 0;
    hrvDisplayRef.current = { sdnn: 0, rmssd: 0 };
    bpmStatsRef.current = { min: 0, max: 0, sum: 0, n: 0 };
    bpmTrendRef.current = [];
    signalPathRef.current = [];
    sweepPosRef.current = 0;
    onReset();
  }, [onReset]);

  return (
    <div className="fixed inset-0 bg-black">
      <canvas
        ref={canvasRef}
        width={CONFIG.CANVAS_WIDTH}
        height={CONFIG.CANVAS_HEIGHT}
        className="w-full h-full absolute inset-0"
      />
      <div className="fixed bottom-0 left-0 right-0 h-12 grid grid-cols-2 z-10">
        <button
          onClick={onStartMeasurement}
          className={`font-semibold text-sm tracking-wide transition-colors border-t backdrop-blur-sm ${
            isMonitoring
              ? 'bg-red-500/15 hover:bg-red-500/25 active:bg-red-500/35 text-red-300 border-red-500/30 border-r'
              : 'bg-emerald-600/15 hover:bg-emerald-600/25 active:bg-emerald-600/35 text-emerald-400 border-emerald-500/30 border-r'
          }`}
        >
          {isMonitoring ? 'DETENER' : 'INICIAR'}
        </button>
        <button
          onClick={handleReset}
          className="bg-slate-700/15 hover:bg-slate-700/25 active:bg-slate-700/35 text-slate-300 font-semibold text-sm tracking-wide transition-colors border-t border-slate-700/40 backdrop-blur-sm"
        >
          RESET
        </button>
      </div>
    </div>
  );
};

export default PPGSignalMeter;