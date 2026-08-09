import React, { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { ECGWaveformSynthesizer } from '../modules/ecg/ECGWaveformSynthesizer';
import { rhythmFromStatus } from '../modules/ecg/ECGComplexModel';
import { EcgSceneManager } from '../render/ecg/EcgSceneManager';
import { EcgRibbonMesh } from '../render/ecg/EcgRibbonMesh';
import { EcgParticles } from '../render/ecg/EcgParticles';
import type { EcgChannelConfig, MonitorLayout } from '../render/ecg/types';

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
};

const ECG_CHANNEL: EcgChannelConfig = {
  baseY: 120,
  amplitude: 1520,
  width: 840,
  depth: 900,
  timeWindowMs: 3200,
  depthSpanMs: 130,
  color: 0x00ff88,
  emissive: 0x00ff88,
  ribbonSegments: 260,
  ribbonSubSegments: 6,
};

const PPG_CHANNEL: EcgChannelConfig = {
  baseY: -120,
  amplitude: 1100,
  width: 840,
  depth: 900,
  timeWindowMs: 3200,
  depthSpanMs: 130,
  color: 0xff7050,
  emissive: 0xff4500,
  ribbonSegments: 260,
  ribbonSubSegments: 6,
};

const LAYOUT: MonitorLayout = {
  stage: { x0: 58, x1: 782, y0: 268, y1: 1260 },
  ecgViewport: { y0: 280, y1: 760 },
  ppgViewport: { y0: 780, y1: 1260 },
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
  const glContainerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneManagerRef = useRef<EcgSceneManager | null>(null);
  const ecgMeshRef = useRef<EcgRibbonMesh | null>(null);
  const ppgMeshRef = useRef<EcgRibbonMesh | null>(null);
  const particlesRef = useRef<EcgParticles | null>(null);
  const synthRef = useRef<ECGWaveformSynthesizer | null>(null);
  const bgCacheRef = useRef<HTMLCanvasElement | null>(null);

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

  useEffect(() => {
    propsRef.current = {
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
    };

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
  }, [
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
  ]);

  useEffect(() => {
    const container = glContainerRef.current;
    if (!container) return;

    const manager = new EcgSceneManager(
      container,
      {
        backgroundColor: 0x000a05,
        fogNear: 800,
        fogFar: 3200,
        pixelRatioCap: 2,
        antialias: true,
        powerPreference: 'high-performance',
      },
      LAYOUT
    );

    sceneManagerRef.current = manager;
    ecgMeshRef.current = manager.createChannel(ECG_CHANNEL);
    ppgMeshRef.current = manager.createChannel(PPG_CHANNEL);
    particlesRef.current = new EcgParticles(manager as unknown as THREE.Scene, PPG_CHANNEL, 160);
    synthRef.current = new ECGWaveformSynthesizer({ sampleRateHz: 60, maxActiveComplexes: 24 });

    manager.start();

    return () => {
      manager.dispose();
      sceneManagerRef.current = null;
      ecgMeshRef.current = null;
      ppgMeshRef.current = null;
      particlesRef.current = null;
      synthRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!isPeak || !synthRef.current || !sceneManagerRef.current) return;
    const rrSample = rrIntervals && rrIntervals.length > 0 ? rrIntervals[rrIntervals.length - 1] : 800;
    const rhythm = rhythmFromStatus(arrhythmiaStatus, bpm, rrIntervals);
    const complex = synthRef.current.onHeartBeat(Date.now(), rrSample, rhythm);
    if (complex) {
      sceneManagerRef.current.triggerBeatPulse(1);
      beatFlashRef.current = { time: Date.now(), age: 0 };
      beatHistoryRef.current.push({ isArrhythmia: rhythm !== 'NSR', time: Date.now() });
      if (beatHistoryRef.current.length > 20) beatHistoryRef.current = beatHistoryRef.current.slice(-20);
    }
  }, [isPeak, arrhythmiaStatus, bpm, rrIntervals]);

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
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, stageY0, W, stageY1 - stageY0);
    ctx.clip();

    ctx.strokeStyle = CONFIG.GRID_MINOR;
    ctx.lineWidth = 0.5;
    for (let y = stageY0; y <= stageY1; y += 8) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    for (let x = 0; x < W; x += 8) {
      ctx.beginPath(); ctx.moveTo(x, stageY0); ctx.lineTo(x, stageY1); ctx.stroke();
    }

    ctx.strokeStyle = CONFIG.GRID_MAJOR;
    ctx.lineWidth = 0.8;
    for (let y = stageY0; y <= stageY1; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    for (let x = 0; x < W; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, stageY0); ctx.lineTo(x, stageY1); ctx.stroke();
    }

    ctx.strokeStyle = CONFIG.GRID_MAJOR;
    ctx.lineWidth = 1;
    for (let y = stageY0; y <= stageY1; y += 200) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    for (let x = 0; x < W; x += 200) {
      ctx.beginPath(); ctx.moveTo(x, stageY0); ctx.lineTo(x, stageY1); ctx.stroke();
    }
    ctx.restore();
  }, []);

  const drawHeader = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const W = CONFIG.CANVAS_WIDTH;
    const { quality, elapsedTime } = propsRef.current;
    ctx.font = `bold 11px ${CONFIG.FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = CONFIG.SIGNAL_COLOR;
    ctx.fillText('● CARDIAC MONITOR — DUAL CHANNEL', 14, 22);
    ctx.font = `9px ${CONFIG.FONT}`;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.6)';
    ctx.fillText('ECG + PPG · 3D · REAL-TIME', 14, 36);

    const recentBeat = now - beatFlashRef.current.time < 400;
    const hx = 240;
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
    const arrCount = beatHistory.filter((b) => b.isArrhythmia).length;
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
    ctx.fillText('SWEEP 25mm/s · FILTER 0.5-4Hz · SOURCE PPG+ECG', 380, ly);

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

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    const drawOverlay = () => {
      const now = Date.now();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawHeader(ctx, now);
      drawMetricsRow(ctx, now);
      drawAnalyticsBand(ctx);
      drawFooter(ctx);
      requestAnimationFrame(drawOverlay);
    };
    drawOverlay();

    return () => window.removeEventListener('resize', resize);
  }, [drawHeader, drawMetricsRow, drawAnalyticsBand, drawFooter]);

  const handleReset = useCallback(() => {
    beatHistoryRef.current = [];
    ibiDisplayRef.current = 0;
    hrvDisplayRef.current = { sdnn: 0, rmssd: 0 };
    bpmStatsRef.current = { min: 0, max: 0, sum: 0, n: 0 };
    bpmTrendRef.current = [];
    amplitudeStatsRef.current = { min: -50, max: 50, range: 100 };
    synthRef.current?.reset();
    onReset();
  }, [onReset]);

  return (
    <div className="fixed inset-0 bg-black">
      <div ref={glContainerRef} className="absolute inset-0" />
      <canvas ref={overlayRef} className="absolute inset-0 pointer-events-none" />
      <div className="fixed bottom-0 left-0 right-0 h-14 grid grid-cols-2 z-10">
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