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
  WINDOW_MS: 2800,
  TARGET_FPS: 30,
  BUFFER_SIZE: 400,
  FONT: '"SF Mono", Consolas, monospace',
  COLORS: {
    BG_DEEP: '#020409',
    BG_TOP: '#081226',
    SIGNAL_NORMAL: '#3df6a8',
    SIGNAL_CORE: '#eafff6',
    SIGNAL_GLOW: 'rgba(61, 246, 168, 0.55)',
    SIGNAL_ARRHYTHMIA: '#ff5d5d',
    ARRHYTHMIA_GLOW: 'rgba(255, 93, 93, 0.55)',
    TEXT_PRIMARY: '#3df6a8',
    TEXT_SECONDARY: '#8fa8bd',
    TEXT_WARNING: '#fbbf24',
    TEXT_DANGER: '#ff5d5d',
    SCALE_TEXT: '#4a6276',
    ACCENT_CYAN: '#4dd7fe',
    IBI_TEXT: '#67e8f9',
    CARD_BORDER: 'rgba(61, 246, 168, 0.35)',
    PANEL_BG_TOP: 'rgba(9, 18, 32, 0.9)',
    PANEL_BG_BOTTOM: 'rgba(3, 8, 16, 0.95)',
  }
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
  pressure
}: PPGSignalMeterProps) => {
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const isRunningRef = useRef(false);
  const dataBufferRef = useRef<CircularBuffer | null>(null);
  
  const propsRef = useRef({ value, quality, isFingerDetected, arrhythmiaStatus, preserveResults, isPeak, bpm, spo2, rrIntervals, rawArrhythmiaData, elapsedTime, perfusionIndex, pressure });
  
  const beatArrhythmiaRef = useRef(false);
  const lastArrhythmiaCountRef = useRef(0);
  const beatHistoryRef = useRef<{ isArrhythmia: boolean; time: number }[]>([]);
  const amplitudeStatsRef = useRef({ min: -50, max: 50, range: 100 });
  
  const ibiDisplayRef = useRef<number>(0);
  const hrvDisplayRef = useRef<{ sdnn: number; rmssd: number }>({ sdnn: 0, rmssd: 0 });
  const bpmStatsRef = useRef<{ min: number; max: number; sum: number; n: number }>({ min: 0, max: 0, sum: 0, n: 0 });
  const bpmTrendRef = useRef<{ t: number; bpm: number }[]>([]);
  const lastHrvUpdateRef = useRef<number>(0);
  const lastBpmStatsUpdateRef = useRef<number>(0);

  const bgCacheRef = useRef<HTMLCanvasElement | null>(null);
  const scanlineCacheRef = useRef<HTMLCanvasElement | null>(null);

  // ---------- CÁMARA 3D (proyección en perspectiva manual, sin librerías) ----------
  const computeCamera = useCallback((now: number) => {
    const pitch = (24 + 2.4 * Math.sin(now / 9000)) * Math.PI / 180;
    const yaw = 2.6 * Math.sin(now / 13000 + 1.7) * Math.PI / 180;
    return {
      cth: Math.cos(pitch), sth: Math.sin(pitch),
      cph: Math.cos(yaw), sph: Math.sin(yaw),
      H: 650, D: 2600, F: 2350,
      cx: 420, cy: 700
    };
  }, []);

  const project = useCallback((x: number, y: number, z: number, cam: ReturnType<typeof computeCamera>) => {
    const zr = -x * cam.sph + z * cam.cph;
    const xr = x * cam.cph + z * cam.sph;
    const yw = y - cam.H;
    const y1 = yw * cam.cth - zr * cam.sth;
    const z2 = yw * cam.sth + zr * cam.cth;
    const zc = cam.D - z2;
    const inv = cam.F / zc;
    return { sx: cam.cx + xr * inv, sy: cam.cy - y1 * inv, zc };
  }, []);

  const beatFlashRef = useRef({ time: 0, age: Infinity });

  // ---------- Fondo estático cacheado ----------
  const drawBackground = useCallback((ctx: CanvasRenderingContext2D) => {
    const { CANVAS_WIDTH: W, CANVAS_HEIGHT: H, COLORS } = CONFIG;
    const bgGrad = ctx.createRadialGradient(W / 2, H * 0.36, 0, W / 2, H * 0.36, Math.max(W, H) / 1.05);
    bgGrad.addColorStop(0, '#0b1730');
    bgGrad.addColorStop(0.5, '#060d1c');
    bgGrad.addColorStop(1, COLORS.BG_DEEP);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    const topGlow = ctx.createRadialGradient(W * 0.5, -120, 0, W * 0.5, -120, W * 0.55);
    topGlow.addColorStop(0, 'rgba(45, 140, 220, 0.10)');
    topGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = topGlow;
    ctx.fillRect(0, 0, W, 500);

    // Luz ambiental del escenario 3D (centro)
    const stageGlow = ctx.createRadialGradient(W / 2, 780, 0, W / 2, 780, 480);
    stageGlow.addColorStop(0, 'rgba(20, 80, 60, 0.10)');
    stageGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = stageGlow;
    ctx.fillRect(0, 264, W, 980);
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

  const ensureScanlineCache = useCallback(() => {
    if (!scanlineCacheRef.current) {
      const offscreen = document.createElement('canvas');
      offscreen.width = CONFIG.CANVAS_WIDTH;
      offscreen.height = CONFIG.CANVAS_HEIGHT;
      const offCtx = offscreen.getContext('2d', { alpha: true })!;
      offCtx.strokeStyle = 'rgba(0, 0, 0, 0.10)';
      offCtx.lineWidth = 1;
      offCtx.beginPath();
      for (let y = 1; y < CONFIG.CANVAS_HEIGHT; y += 4) {
        offCtx.moveTo(0, y);
        offCtx.lineTo(CONFIG.CANVAS_WIDTH, y);
      }
      offCtx.stroke();
      const vg = offCtx.createRadialGradient(
        CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2, CONFIG.CANVAS_HEIGHT * 0.3,
        CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2, CONFIG.CANVAS_HEIGHT * 0.78
      );
      vg.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vg.addColorStop(1, 'rgba(0, 0, 0, 0.32)');
      offCtx.fillStyle = vg;
      offCtx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);
      scanlineCacheRef.current = offscreen;
    }
  }, []);

  // ---------- Paneles de cristal ----------
  const drawGlassPanel = (
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    borderColor: string,
    accent: string
  ) => {
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, CONFIG.COLORS.PANEL_BG_TOP);
    grad.addColorStop(1, CONFIG.COLORS.PANEL_BG_BOTTOM);
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
    ctx.save();
    ctx.shadowColor = borderColor;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 3, y + 1.5);
    ctx.lineTo(x + w - 3, y + 1.5);
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.fillRect(x, y, w, 3);
  };

  const cardLabel = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) => {
    ctx.font = `bold 10px ${CONFIG.FONT}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(text, x, y);
  };

  // ---------- Cabecera ----------
  const drawHeader = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const { CANVAS_WIDTH: W, COLORS } = CONFIG;
    const { quality, elapsedTime } = propsRef.current;

    ctx.font = `bold 12px ${CONFIG.FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.TEXT_PRIMARY;
    ctx.fillText('● PPG MONITOR v5', 14, 24);
    ctx.font = `9px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('CARDIAC RHYTHM STATION', 14, 40);

    const recentBeat = now - beatFlashRef.current.time < 400;
    const hx = 220;
    ctx.font = `16px ${CONFIG.FONT}`;
    ctx.fillStyle = recentBeat ? '#ff6b6b' : COLORS.TEXT_DANGER;
    ctx.textAlign = 'center';
    if (recentBeat && propsRef.current.isFingerDetected) {
      const p = 1 - (now - beatFlashRef.current.time) / 400;
      ctx.save();
      ctx.shadowColor = 'rgba(255, 80, 80, 0.9)';
      ctx.shadowBlur = 10 + 24 * p;
      ctx.scale(1 + 0.18 * p, 1 + 0.18 * p);
      ctx.fillText('♥', hx / (1 + 0.18 * p), 32);
      ctx.restore();
    } else {
      ctx.save();
      ctx.shadowColor = 'rgba(255, 80, 80, 0.6)';
      ctx.shadowBlur = 8;
      ctx.fillText('♥', hx, 32);
      ctx.restore();
    }
    ctx.font = `9px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.textAlign = 'left';
    ctx.fillText('LIVE', hx + 18, 32);

    // Barra de calidad centrada
    const cxc = W / 2;
    const bw = 150;
    ctx.textAlign = 'center';
    cardLabel(ctx, 'CALIDAD SEÑAL', cxc, 16, COLORS.TEXT_SECONDARY);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(cxc - bw / 2, 22, bw, 8);
    const qGrad = ctx.createLinearGradient(cxc - bw / 2, 0, cxc - bw / 2 + bw, 0);
    if (quality > 60) { qGrad.addColorStop(0, '#166534'); qGrad.addColorStop(1, '#3df6a8'); }
    else if (quality > 30) { qGrad.addColorStop(0, '#854d0e'); qGrad.addColorStop(1, '#fbbf24'); }
    else { qGrad.addColorStop(0, '#7f1d1d'); qGrad.addColorStop(1, '#ff5d5d'); }
    ctx.fillStyle = qGrad;
    ctx.fillRect(cxc - bw / 2, 22, bw * Math.min(1, quality / 100), 8);
    ctx.font = `bold 10px ${CONFIG.FONT}`;
    ctx.fillStyle = quality > 60 ? COLORS.TEXT_PRIMARY : quality > 30 ? COLORS.TEXT_WARNING : COLORS.TEXT_DANGER;
    ctx.fillText(`${quality.toFixed(0)}%`, cxc + bw / 2 + 24, 30);

    // Reloj y cronómetro
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const t = Math.max(0, Math.floor(elapsedTime || 0));
    const em = String(Math.floor(t / 60)).padStart(2, '0');
    const es = String(t % 60).padStart(2, '0');
    ctx.textAlign = 'right';
    ctx.font = `bold 13px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.TEXT_PRIMARY;
    ctx.fillText(`⏱ ${em}:${es}`, W - 14, 24);
    ctx.font = `9px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText(`${hh}:${mm}:${ss}`, W - 14, 40);
  }, []);

  // ---------- Fila de métricas ----------
  const drawMetricsRow = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const { COLORS } = CONFIG;
    const { bpm, spo2, perfusionIndex, pressure, rrIntervals } = propsRef.current;

    const y = 62;
    const h = 196;
    const gap = 12;
    const cardW = (840 - gap * 5) / 4;
    const xs = [gap, gap * 2 + cardW, gap * 3 + cardW * 2, gap * 4 + cardW * 3];

    // ---- HR ----
    const hrCard = xs[0];
    const hrAlarm = bpm > 0 && (bpm < 60 || bpm > 100);
    drawGlassPanel(ctx, hrCard, y, cardW, h, hrAlarm ? COLORS.TEXT_WARNING : COLORS.TEXT_PRIMARY, 'rgba(61, 246, 168, 0.35)');
    cardLabel(ctx, 'FRECUENCIA', hrCard + 12, y + 20, COLORS.TEXT_SECONDARY);
    const beatAge = now - beatFlashRef.current.time;
    const beatPulse = propsRef.current.isFingerDetected && beatAge < 450 ? (1 - beatAge / 450) : 0;
    const valSize = 58 + 9 * beatPulse;
    ctx.font = `bold ${valSize}px ${CONFIG.FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = bpm > 0 ? COLORS.TEXT_PRIMARY : COLORS.TEXT_SECONDARY;
    ctx.save();
    if (bpm > 0) {
      ctx.shadowColor = `rgba(61, 246, 168, ${0.35 + 0.5 * beatPulse})`;
      ctx.shadowBlur = 14 + 26 * beatPulse;
    }
    ctx.fillText(bpm > 0 ? bpm.toString() : '--', hrCard + 12, y + 92);
    ctx.restore();
    ctx.font = `bold 13px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.textAlign = 'right';
    ctx.fillText('BPM', hrCard + cardW - 12, y + 82);
    if (bpm > 0) {
      let label = '';
      let color = COLORS.TEXT_PRIMARY;
      if (bpm < 60) { label = 'BRADICARDIA'; color = COLORS.TEXT_WARNING; }
      else if (bpm <= 100) { label = 'RITMO NORMAL'; color = COLORS.TEXT_PRIMARY; }
      else { label = 'TAQUICARDIA'; color = COLORS.TEXT_WARNING; }
      ctx.font = `bold 10px ${CONFIG.FONT}`;
      ctx.fillStyle = color;
      ctx.fillText(label, hrCard + 12, y + 116);
    }
    // Ticker de latidos reales (últimos 8)
    cardLabel(ctx, 'LATIDOS', hrCard + 12, y + 146, COLORS.TEXT_SECONDARY);
    const beats = beatHistoryRef.current.slice(-8);
    const dotX0 = hrCard + 12;
    const dotY = y + 172;
    const tickW = cardW - 24;
    for (let i = 0; i < 8; i++) {
      const dx = dotX0 + (i / 7) * tickW;
      if (i < beats.length) {
        const b = beats[i];
        const age = now - b.time;
        const fade = Math.max(0.35, 1 - age / 12000);
        ctx.globalAlpha = fade;
        if (b.isArrhythmia) {
          ctx.fillStyle = COLORS.SIGNAL_ARRHYTHMIA;
          ctx.beginPath();
          ctx.arc(dx, dotY, 5.5, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = COLORS.SIGNAL_NORMAL;
          ctx.beginPath();
          ctx.arc(dx, dotY, 4.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.beginPath();
        ctx.arc(dx, dotY, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (beats.length > 0) {
      const newest = beats[beats.length - 1];
      const age = now - newest.time;
      if (age < 800) {
        const p = age / 800;
        const lx = dotX0 + ((beats.length - 1) / 7) * tickW;
        ctx.beginPath();
        ctx.arc(lx, dotY, 5 + 14 * p, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(61, 246, 168, ${0.5 * (1 - p)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // ---- SpO2 ----
    const spCard = xs[1];
    const spBorder = spo2 >= 95 ? COLORS.TEXT_PRIMARY : spo2 >= 90 ? COLORS.TEXT_WARNING : spo2 > 0 ? COLORS.TEXT_DANGER : COLORS.TEXT_SECONDARY;
    drawGlassPanel(ctx, spCard, y, cardW, h, spBorder, 'rgba(77, 215, 254, 0.35)');
    cardLabel(ctx, 'SATURACIÓN O₂', spCard + 12, y + 20, COLORS.TEXT_SECONDARY);
    ctx.font = `bold 58px ${CONFIG.FONT}`;
    ctx.fillStyle = spBorder;
    ctx.textAlign = 'left';
    ctx.save();
    if (spo2 > 0) {
      ctx.shadowColor = `rgba(77, 215, 254, 0.4)`;
      ctx.shadowBlur = 12;
    }
    ctx.fillText(spo2 > 0 ? spo2.toFixed(0) : '--', spCard + 12, y + 92);
    ctx.restore();
    ctx.font = `bold 13px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.textAlign = 'right';
    ctx.fillText('%', spCard + cardW - 12, y + 82);
    if (spo2 > 0) {
      let label = '';
      let color = COLORS.TEXT_PRIMARY;
      if (spo2 >= 95) { label = 'NORMAL'; color = COLORS.TEXT_PRIMARY; }
      else if (spo2 >= 90) { label = 'HIPOXEMIA LEVE'; color = COLORS.TEXT_WARNING; }
      else { label = 'HIPOXEMIA'; color = COLORS.TEXT_DANGER; }
      ctx.font = `bold 10px ${CONFIG.FONT}`;
      ctx.fillStyle = color;
      ctx.fillText(label, spCard + 12, y + 116);
    }
    cardLabel(ctx, 'OBJETIVO ≥ 95%', spCard + 12, y + 146, COLORS.TEXT_SECONDARY);
    ctx.font = `9px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('PLETH POR PPG', spCard + 12, y + 170);

    // ---- MAP ----
    const mpCard = xs[2];
    const sys = pressure?.systolic || 0;
    const dia = pressure?.diastolic || 0;
    const map = sys > 0 && dia > 0 ? Math.round(dia + (sys - dia) / 3) : 0;
    const pp = sys > 0 && dia > 0 ? sys - dia : 0;
    const mpBorder = map === 0 ? COLORS.TEXT_SECONDARY : (map < 65 || map > 110) ? COLORS.TEXT_WARNING : COLORS.TEXT_PRIMARY;
    drawGlassPanel(ctx, mpCard, y, cardW, h, mpBorder, 'rgba(129, 140, 248, 0.35)');
    cardLabel(ctx, 'PRESIÓN · MAP', mpCard + 12, y + 20, COLORS.TEXT_SECONDARY);
    ctx.font = `bold 58px ${CONFIG.FONT}`;
    ctx.fillStyle = mpBorder;
    ctx.textAlign = 'left';
    ctx.save();
    if (map > 0) {
      ctx.shadowColor = `rgba(129, 140, 248, 0.4)`;
      ctx.shadowBlur = 12;
    }
    ctx.fillText(map > 0 ? `${map}` : '--', mpCard + 12, y + 92);
    ctx.restore();
    ctx.font = `bold 13px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.textAlign = 'right';
    ctx.fillText('mmHg', mpCard + cardW - 12, y + 82);
    ctx.font = `bold 11px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText(sys > 0 ? `${sys}/${dia}` : '--/--', mpCard + 12, y + 116);
    cardLabel(ctx, `PP ${pp > 0 ? pp + ' mmHg' : '--'}`, mpCard + 12, y + 146, COLORS.TEXT_SECONDARY);
    ctx.font = `9px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('OBJETIVO 70–105', mpCard + 12, y + 170);

    // ---- PI + RESP ----
    const piCard = xs[3];
    const piVal = perfusionIndex || 0;
    const piBorder = piVal >= 0.02 ? COLORS.TEXT_PRIMARY : piVal >= 0.005 ? COLORS.TEXT_WARNING : COLORS.TEXT_DANGER;
    drawGlassPanel(ctx, piCard, y, cardW, h, piBorder, 'rgba(251, 191, 36, 0.3)');
    cardLabel(ctx, 'PERFUSIÓN · PI', piCard + 12, y + 20, COLORS.TEXT_SECONDARY);
    ctx.font = `bold 58px ${CONFIG.FONT}`;
    ctx.fillStyle = piBorder;
    ctx.textAlign = 'left';
    ctx.fillText(piVal > 0 ? (piVal * 100).toFixed(1) : '--', piCard + 12, y + 92);
    ctx.font = `bold 13px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.textAlign = 'right';
    ctx.fillText('%', piCard + cardW - 12, y + 82);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(piCard + 12, y + 104, cardW - 24, 6);
    const piPct = Math.min(1, piVal / 0.05);
    ctx.fillStyle = piBorder;
    ctx.fillRect(piCard + 12, y + 104, (cardW - 24) * piPct, 6);

    let respRate = 0;
    if (rrIntervals && rrIntervals.length >= 4) {
      const m = rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length;
      let zc = 0;
      for (let i = 1; i < rrIntervals.length; i++) {
        if ((rrIntervals[i - 1] - m) * (rrIntervals[i] - m) < 0) zc++;
      }
      const cycles = zc / 2;
      const totalSec = rrIntervals.reduce((a, b) => a + b, 0) / 1000;
      if (totalSec > 0) respRate = Math.round((cycles / totalSec) * 60);
      if (respRate < 6 || respRate > 40) respRate = 0;
    }
    const respColor = respRate === 0 ? COLORS.TEXT_SECONDARY : (respRate < 12 || respRate > 20) ? COLORS.TEXT_WARNING : COLORS.TEXT_PRIMARY;
    ctx.font = `bold 10px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('RESP (EST.)', piCard + 12, y + 146);
    ctx.font = `bold 22px ${CONFIG.FONT}`;
    ctx.fillStyle = respColor;
    ctx.fillText(respRate > 0 ? `${respRate}` : '--', piCard + 12, y + 172);
    ctx.font = `bold 10px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('rpm', piCard + 46, y + 172);
  }, []);

  // ---------- Escenario 3D ----------
  const draw3DStage = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const { COLORS } = CONFIG;
    const { preserveResults, isFingerDetected: detected } = propsRef.current;
    const stage = { x0: 60, x1: 780, y0: 272, y1: 1252 };
    const cam = computeCamera(now);
    const proj = (x: number, y: number, z: number) => project(x, y, z, cam);

    ctx.save();
    ctx.beginPath();
    ctx.rect(stage.x0, stage.y0, stage.x1 - stage.x0, stage.y1 - stage.y0);
    ctx.clip();

    // Plano 3D: polígono (línea trasera y delantera del plano en pantalla)
    const plBackL = proj(-340, 0, -900);
    const plBackR = proj(340, 0, -900);
    const plFrontL = proj(-340, 0, 0);
    const plFrontR = proj(340, 0, 0);
    const planeGrad = ctx.createLinearGradient(0, plBackL.sy, 0, plFrontL.sy);
    planeGrad.addColorStop(0, 'rgba(6, 22, 34, 0.35)');
    planeGrad.addColorStop(1, 'rgba(10, 40, 30, 0.55)');
    ctx.fillStyle = planeGrad;
    ctx.beginPath();
    ctx.moveTo(plBackL.sx, plBackL.sy);
    ctx.lineTo(plBackR.sx, plBackR.sy);
    ctx.lineTo(plFrontR.sx, plFrontR.sy);
    ctx.lineTo(plFrontL.sx, plFrontL.sy);
    ctx.closePath();
    ctx.fill();

    // Rejilla del plano en perspectiva
    ctx.strokeStyle = 'rgba(61, 246, 168, 0.10)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const x = -340 + (i / 10) * 680;
      const a = proj(x, 0, -900);
      const b = proj(x, 0, 0);
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }
    for (let i = 0; i <= 8; i++) {
      const z = -900 + (i / 8) * 900;
      const a = proj(-340, 0, z);
      const b = proj(340, 0, z);
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }
    // Bordes del plano
    ctx.strokeStyle = 'rgba(61, 246, 168, 0.28)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(plFrontL.sx, plFrontL.sy);
    ctx.lineTo(plFrontR.sx, plFrontR.sy);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(61, 246, 168, 0.14)';
    ctx.beginPath();
    ctx.moveTo(plBackL.sx, plBackL.sy);
    ctx.lineTo(plBackR.sx, plBackR.sy);
    ctx.stroke();

    // Ticks de tiempo a lo largo de la línea de la onda (z = -380)
    for (let s = 0; s <= 2.8; s += 0.5) {
      const x = -330 + (s / 2.8) * 660;
      const a = proj(x, 0, -380);
      const b = proj(x, 12, -380);
      ctx.strokeStyle = 'rgba(77, 215, 254, 0.30)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
      if (s === Math.round(s)) {
        ctx.font = `9px ${CONFIG.FONT}`;
        ctx.fillStyle = COLORS.SCALE_TEXT;
        ctx.textAlign = 'center';
        ctx.fillText(`${s}s`, a.sx, a.sy - 8);
      }
    }

    const hasWave = !(preserveResults && !detected);

    if (hasWave) {
      const { value: signalValue, isPeak: peak, arrhythmiaStatus: arrStatus } = propsRef.current;
      const scaledValue = signalValue * 2;

      if (peak) {
        beatFlashRef.current = { time: now, age: 0 };
        const currentCount = arrStatus ? parseInt(arrStatus.split('|')[1] || '0') : 0;
        if (currentCount > lastArrhythmiaCountRef.current) {
          beatArrhythmiaRef.current = true;
          lastArrhythmiaCountRef.current = currentCount;
          const { rrIntervals: rr } = propsRef.current;
          const lastRR = rr && rr.length > 0 ? rr[rr.length - 1] : 800;
          const retroDuration = Math.min(Math.max(lastRR, 400), 1500);
          dataBufferRef.current?.markArrhythmiaBack(retroDuration);
        } else {
          beatArrhythmiaRef.current = false;
        }
        beatHistoryRef.current.push({ isArrhythmia: beatArrhythmiaRef.current, time: now });
        if (beatHistoryRef.current.length > 20) {
          beatHistoryRef.current = beatHistoryRef.current.slice(-20);
        }
      }
      const currentIsArrhythmia = beatArrhythmiaRef.current;

      dataBufferRef.current?.push({ time: now, value: scaledValue, isArrhythmia: currentIsArrhythmia });

      const buffer = dataBufferRef.current;
      if (buffer) {
        const points = buffer.getPoints();
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

        // Respuesta al latido: rebote de amplitud + flash de brillo
        const beatAge = now - beatFlashRef.current.time;
        const beatPulse = Math.exp(-Math.max(0, beatAge) / 320);
        const ampBoost = 1 + 0.06 * beatPulse;
        const waveBright = 0.72 + 0.28 * beatPulse;

        const proj3: { sx: number; sy: number; syPlane: number; isArr: boolean; x: number; y: number; zc: number }[] = [];
        const pointsList = points.length > 400 ? points.slice(-400) : points;
        for (let i = 0; i < pointsList.length; i++) {
          const pt = pointsList[i];
          const age = now - pt.time;
          if (age > CONFIG.WINDOW_MS) continue;
          const x = -330 + ((CONFIG.WINDOW_MS - age) / CONFIG.WINDOW_MS) * 660;
          const z = -380 + (age / CONFIG.WINDOW_MS) * 130;
          const normalizedY = (stats.max - pt.value) / stats.range;
          const worldY = (normalizedY - 0.5) * 560 * ampBoost;
          const p = proj(x, worldY, z);
          const pp = proj(x, 0, z);
          proj3.push({ sx: p.sx, sy: p.sy, syPlane: pp.sy, isArr: pt.isArrhythmia, x, y: worldY, zc: p.zc });
        }

        if (proj3.length > 2) {
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';

          // Espejo difuso en el plano (reflejo atenuado)
          ctx.save();
          ctx.globalAlpha = 0.12;
          ctx.strokeStyle = COLORS.SIGNAL_NORMAL;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          let mstarted = false;
          for (const c of proj3) {
            const m = proj(c.x, -c.y * 0.5, -380);
            if (!mstarted) { ctx.moveTo(m.sx, m.sy); mstarted = true; }
            else ctx.lineTo(m.sx, m.sy);
          }
          ctx.stroke();
          ctx.restore();

          // Relleno de la cinta 3D (de la onda hasta el plano)
          ctx.beginPath();
          ctx.moveTo(proj3[0].sx, proj3[0].sy);
          for (const c of proj3) ctx.lineTo(c.sx, c.sy);
          for (let i = proj3.length - 1; i >= 0; i--) ctx.lineTo(proj3[i].sx, proj3[i].syPlane);
          ctx.closePath();
          const ribbonGrad = ctx.createLinearGradient(0, Math.min(...proj3.map(c => c.sy)) - 20, 0, Math.max(...proj3.map(c => c.syPlane)) + 20);
          ribbonGrad.addColorStop(0, 'rgba(61, 246, 168, 0.16)');
          ribbonGrad.addColorStop(0.5, 'rgba(61, 246, 168, 0.06)');
          ribbonGrad.addColorStop(1, 'rgba(61, 246, 168, 0.0)');
          ctx.fillStyle = ribbonGrad;
          ctx.fill();

          // Segmentación normal / arritmia (con el punto del plano para el relleno 3D)
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

          // Vallas de profundidad (cada 4 muestras) — refuerza el 3D
          ctx.strokeStyle = 'rgba(61, 246, 168, 0.10)';
          ctx.lineWidth = 1;
          for (let i = 0; i < proj3.length; i += 4) {
            const c = proj3[i];
            ctx.beginPath();
            ctx.moveTo(c.sx, c.sy);
            ctx.lineTo(c.sx, c.syPlane);
            ctx.stroke();
          }

          // Relleno rojo de segmentos arrítmicos
          for (const run of runs) {
            if (!run.arr) continue;
            ctx.beginPath();
            ctx.moveTo(run.pts[0].sx, run.pts[0].sy);
            for (const c of run.pts) ctx.lineTo(c.sx, c.sy);
            for (let i = run.pts.length - 1; i >= 0; i--) ctx.lineTo(run.pts[i].sx, run.pts[i].syPlane);
            ctx.closePath();
            ctx.fillStyle = 'rgba(255, 93, 93, 0.12)';
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
                ctx.shadowColor = arr ? COLORS.ARRHYTHMIA_GLOW : COLORS.SIGNAL_GLOW;
                ctx.shadowBlur = blur;
              }
              ctx.strokeStyle = arr ? (useCore ? '#ffd9d9' : COLORS.SIGNAL_ARRHYTHMIA) : (useCore ? COLORS.SIGNAL_CORE : COLORS.SIGNAL_NORMAL);
              ctx.lineWidth = width;
              ctx.stroke();
            }
            ctx.restore();
          };

          // Halo difuso + trazo + núcleo (brillo reactivo al latido)
          strokePass(false, 9, 0.20, 24);
          strokePass(true, 9, 0.20, 24);
          strokePass(false, 3, 1, 14);
          strokePass(true, 3, 1, 14);
          strokePass(false, 1.2, 0.9, 0, true);
          strokePass(true, 1.2, 0.9, 0, true);

          // Barrido luminoso en el borde actual
          const last = proj3[proj3.length - 1];
          const beamTop = proj(last.x, Math.max(0, last.y) + 190, -380);
          const beamBottom = proj(last.x, -60, -380);
          const beamGrad = ctx.createLinearGradient(beamTop.sx - 70, 0, beamTop.sx + 6, 0);
          const beamPulse = 0.14 + 0.08 * Math.sin(now / 240) + 0.10 * beatPulse;
          beamGrad.addColorStop(0, 'rgba(61, 246, 168, 0)');
          beamGrad.addColorStop(1, `rgba(61, 246, 168, ${beamPulse})`);
          ctx.fillStyle = beamGrad;
          ctx.fillRect(beamTop.sx - 70, Math.min(beamTop.sy, beamBottom.sy), 76, Math.abs(beamBottom.sy - beamTop.sy));
          ctx.save();
          ctx.shadowColor = 'rgba(61, 246, 168, 0.9)';
          ctx.shadowBlur = 12;
          ctx.fillStyle = `rgba(61, 246, 168, ${0.35 + 0.2 * beatPulse})`;
          ctx.fillRect(beamTop.sx - 1.5, Math.min(beamTop.sy, beamBottom.sy), 1.5, Math.abs(beamBottom.sy - beamTop.sy));
          ctx.restore();

          // Picos, valles e IBI (en espacio 3D proyectado)
          const history = beatHistoryRef.current;
          const peaks: { sx: number; sy: number; zc: number; isArrhythmia: boolean; time: number }[] = [];
          const valleys: { sx: number; sy: number }[] = [];

          for (const beat of history) {
            const age = now - beat.time;
            if (age > CONFIG.WINDOW_MS || age < 0) continue;
            const x = -330 + ((CONFIG.WINDOW_MS - age) / CONFIG.WINDOW_MS) * 660;
            if (x < -335 || x > 335) continue;
            let closestPt: PPGDataPoint | null = null;
            let minDist = Infinity;
            for (let j = 0; j < pointsList.length; j++) {
              const pt = pointsList[j];
              const dist = Math.abs(pt.time - beat.time);
              if (dist < minDist) { minDist = dist; closestPt = pt; }
            }
            if (closestPt && minDist < 200) {
              const normalizedY = (stats.max - closestPt.value) / stats.range;
              const worldY = (normalizedY - 0.5) * 560 * ampBoost;
              const p = proj(x, worldY, -380);
              peaks.push({ sx: p.sx, sy: p.sy, zc: p.zc, isArrhythmia: beat.isArrhythmia, time: beat.time });
            }
          }

          for (let b = 0; b < peaks.length - 1; b++) {
            const t0 = peaks[b].time;
            const t1 = peaks[b + 1].time;
            let minVal = Infinity;
            let minPt: PPGDataPoint | null = null;
            for (let j = 0; j < pointsList.length; j++) {
              const pt = pointsList[j];
              if (pt.time > t0 && pt.time < t1 && pt.value < minVal) {
                minVal = pt.value;
                minPt = pt;
              }
            }
            if (minPt) {
              const age2 = now - minPt.time;
              const x = -330 + ((CONFIG.WINDOW_MS - age2) / CONFIG.WINDOW_MS) * 660;
              if (x >= -335 && x <= 335) {
                const normalizedY = (stats.max - minPt.value) / stats.range;
                const worldY = (normalizedY - 0.5) * 560 * ampBoost;
                const p = proj(x, worldY, -380);
                valleys.push({ sx: p.sx, sy: p.sy });
              }
            }
          }

          for (let i = 0; i < peaks.length - 1; i++) {
            const p1 = peaks[i];
            const p2 = peaks[i + 1];
            const ibiMs = Math.abs(p1.time - p2.time);
            if (ibiMs > 0 && ibiMs < 3000) {
              const midX = (p1.sx + p2.sx) / 2;
              const topY = Math.min(p1.sy, p2.sy) - 26;
              ctx.strokeStyle = 'rgba(103, 232, 249, 0.5)';
              ctx.lineWidth = 1.2;
              ctx.beginPath();
              ctx.moveTo(p1.sx, topY + 8);
              ctx.lineTo(p1.sx, topY);
              ctx.lineTo(p2.sx, topY);
              ctx.lineTo(p2.sx, topY + 8);
              ctx.stroke();
              ctx.font = `9px ${CONFIG.FONT}`;
              ctx.fillStyle = COLORS.IBI_TEXT;
              ctx.textAlign = 'center';
              ctx.fillText(`${ibiMs}ms`, midX, topY - 4);
            }
          }

          peaks.forEach(p => {
            const color = p.isArrhythmia ? COLORS.SIGNAL_ARRHYTHMIA : COLORS.SIGNAL_NORMAL;
            const r = (p.isArrhythmia ? 10 : 8) * (3000 / p.zc);
            const sg = ctx.createRadialGradient(p.sx - r * 0.35, p.sy - r * 0.35, r * 0.1, p.sx, p.sy, r);
            sg.addColorStop(0, p.isArrhythmia ? '#ffe1e1' : '#d8ffe9');
            sg.addColorStop(0.45, color);
            sg.addColorStop(1, p.isArrhythmia ? '#7f1d1d' : '#0f5132');
            ctx.save();
            ctx.shadowColor = p.isArrhythmia ? 'rgba(255, 93, 93, 0.8)' : 'rgba(61, 246, 168, 0.8)';
            ctx.shadowBlur = 16;
            ctx.beginPath();
            ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
            ctx.fillStyle = sg;
            ctx.fill();
            ctx.restore();
            ctx.beginPath();
            ctx.arc(p.sx, p.sy, Math.max(1.5, r * 0.25), 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            ctx.font = `bold 11px ${CONFIG.FONT}`;
            ctx.fillStyle = p.isArrhythmia ? COLORS.TEXT_DANGER : COLORS.SIGNAL_NORMAL;
            ctx.textAlign = 'center';
            ctx.fillText(p.isArrhythmia ? 'A' : 'N', p.sx, p.sy - r - 10);

            // Anillo de pulso expansivo por latido
            const pAge = now - p.time;
            if (pAge < 900) {
              const pr = pAge / 900;
              ctx.beginPath();
              ctx.arc(p.sx, p.sy, r + 12 + 30 * pr, 0, Math.PI * 2);
              ctx.strokeStyle = p.isArrhythmia
                ? `rgba(255, 93, 93, ${0.6 * (1 - pr)})`
                : `rgba(61, 246, 168, ${0.6 * (1 - pr)})`;
              ctx.lineWidth = 2.5 * (1 - pr) + 0.5;
              ctx.stroke();
            }
            if (p.isArrhythmia) {
              const alpha = (Math.sin(now / 80) + 1) / 2;
              ctx.beginPath();
              ctx.arc(p.sx, p.sy, r + 10, 0, Math.PI * 2);
              ctx.strokeStyle = `rgba(255, 93, 93, ${0.3 + alpha * 0.5})`;
              ctx.lineWidth = 2;
              ctx.stroke();
            }
          });

          valleys.forEach(v => {
            ctx.beginPath();
            ctx.moveTo(v.sx, v.sy + 3);
            ctx.lineTo(v.sx - 4, v.sy + 10);
            ctx.lineTo(v.sx + 4, v.sy + 10);
            ctx.closePath();
            ctx.fillStyle = COLORS.TEXT_SECONDARY;
            ctx.fill();
          });
        }
      }
    }
    ctx.restore();
  }, [computeCamera, project]);

  // ---------- Banda analítica ----------
  const drawAnalyticsBand = useCallback((ctx: CanvasRenderingContext2D) => {
    const { COLORS } = CONFIG;
    const { rrIntervals } = propsRef.current;

    const y = 1264;
    const h = 320;
    const gap = 12;
    const w = (840 - gap * 3) / 2;

    // ---- Izquierda: tendencia PR + HRV ----
    const tx = gap;
    drawGlassPanel(ctx, tx, y, w, h, 'rgba(61, 246, 168, 0.25)', 'rgba(61, 246, 168, 0.2)');
    cardLabel(ctx, 'TENDENCIA PR', tx + 14, y + 22, COLORS.TEXT_SECONDARY);
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
      ctx.strokeStyle = COLORS.TEXT_PRIMARY;
      ctx.lineWidth = 1.8;
      ctx.save();
      ctx.shadowColor = 'rgba(61, 246, 168, 0.45)';
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
      ctx.font = `9px ${CONFIG.FONT}`;
      ctx.fillStyle = COLORS.TEXT_SECONDARY;
      ctx.textAlign = 'left';
      ctx.fillText(`min ${Math.round(minB)}`, tx + 14, y + 46);
      ctx.textAlign = 'right';
      ctx.fillText(`max ${Math.round(maxB)}`, tx + w - 14, y + 46);
    } else {
      ctx.font = `10px ${CONFIG.FONT}`;
      ctx.fillStyle = 'rgba(143, 168, 189, 0.5)';
      ctx.textAlign = 'center';
      ctx.fillText('ACUMULANDO DATOS…', tx + w / 2, y + 90);
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tx + 10, y + 132);
    ctx.lineTo(tx + w - 10, y + 132);
    ctx.stroke();
    cardLabel(ctx, 'VARIABILIDAD HRV', tx + 14, y + 154, COLORS.TEXT_SECONDARY);
    const hrv = hrvDisplayRef.current;
    const ibi = ibiDisplayRef.current;
    const meanRR = rrIntervals && rrIntervals.length > 0
      ? Math.round(rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length)
      : 0;
    ctx.font = `bold 30px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.IBI_TEXT;
    ctx.textAlign = 'left';
    ctx.fillText(ibi > 0 ? `${ibi}` : '--', tx + 14, y + 196);
    ctx.font = `10px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('ms IBI', tx + (ibi > 0 ? 84 : 54), y + 196);
    ctx.font = `12px ${CONFIG.FONT}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText(`SDNN ${hrv.sdnn > 0 ? hrv.sdnn + 'ms' : '--'}`, tx + 14, y + 230);
    ctx.fillText(`RMSSD ${hrv.rmssd > 0 ? hrv.rmssd + 'ms' : '--'}`, tx + 14, y + 252);
    ctx.fillStyle = COLORS.IBI_TEXT;
    ctx.fillText(`x̄ RR ${meanRR > 0 ? meanRR + 'ms' : '--'}`, tx + 14, y + 274);
    const stats = bpmStatsRef.current;
    const meanBpm = stats.n > 0 ? Math.round(stats.sum / stats.n) : 0;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText(`PR x̄ ${meanBpm || '--'} bpm`, tx + 14, y + 296);

    // ---- Derecha: tacograma RR + historial de latidos ----
    const rx = gap * 2 + w;
    drawGlassPanel(ctx, rx, y, w, h, 'rgba(77, 215, 254, 0.25)', 'rgba(77, 215, 254, 0.25)');
    cardLabel(ctx, 'TACOGRAMA RR', rx + 14, y + 22, COLORS.TEXT_SECONDARY);
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
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.fillRect(px0, py0, pw, ph);
      ctx.beginPath();
      ctx.strokeStyle = COLORS.ACCENT_CYAN;
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
      ctx.font = `9px ${CONFIG.FONT}`;
      ctx.fillStyle = COLORS.TEXT_SECONDARY;
      ctx.textAlign = 'left';
      ctx.fillText(`${Math.round(rrMin)}ms`, px0 + 2, py0 + ph - 8);
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(rrMax)}ms`, px0 + pw - 2, py0 + 12);
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx + 10, y + 132);
    ctx.lineTo(rx + w - 10, y + 132);
    ctx.stroke();
    cardLabel(ctx, 'HISTORIAL DE LATIDOS', rx + 14, y + 154, COLORS.TEXT_SECONDARY);
    const beatHistory = beatHistoryRef.current;
    const arrCount = beatHistory.filter(b => b.isArrhythmia).length;
    const normalCount = beatHistory.length - arrCount;
    ctx.font = `9px ${CONFIG.FONT}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.SIGNAL_NORMAL;
    ctx.fillText(`N:${normalCount}`, rx + w - 14, y + 154);
    ctx.fillStyle = arrCount > 0 ? COLORS.SIGNAL_ARRHYTHMIA : COLORS.TEXT_SECONDARY;
    ctx.fillText(` A:${arrCount}`, rx + w - 60, y + 154);

    const dotSpacing = 26;
    const totalWidth = beatHistory.length * dotSpacing;
    const startX = rx + w / 2 - totalWidth / 2;
    const cy = y + 210;
    for (let i = 0; i < beatHistory.length; i++) {
      const beat = beatHistory[i];
      const cx = startX + i * dotSpacing + dotSpacing / 2;
      if (beat.isArrhythmia) {
        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 93, 93, 0.2)';
        ctx.fill();
      }
      const dg = ctx.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, 7);
      dg.addColorStop(0, '#ffffff');
      dg.addColorStop(0.4, beat.isArrhythmia ? COLORS.SIGNAL_ARRHYTHMIA : COLORS.SIGNAL_NORMAL);
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
      ctx.fillStyle = 'rgba(143, 168, 189, 0.5)';
      ctx.textAlign = 'center';
      ctx.fillText('—', rx + w / 2, cy + 4);
    }

    // Tachograma compacto de barras (últimas RR) bajo el historial
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx + 10, y + 240);
    ctx.lineTo(rx + w - 10, y + 240);
    ctx.stroke();
    cardLabel(ctx, 'ÚLTIMOS IBI', rx + 14, y + 262, COLORS.TEXT_SECONDARY);
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

  // ---------- Pie ----------
  const drawFooter = useCallback((ctx: CanvasRenderingContext2D) => {
    const { COLORS } = CONFIG;
    const { bpm, spo2 } = propsRef.current;

    ctx.font = `9px ${CONFIG.FONT}`;
    ctx.textAlign = 'left';
    const lx = 14;
    const ly = 1666;

    ctx.fillStyle = COLORS.SIGNAL_NORMAL;
    ctx.fillRect(lx, ly - 6, 15, 3);
    ctx.beginPath();
    ctx.arc(lx + 22, ly - 4, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('Normal (N)', lx + 30, ly);

    ctx.fillStyle = COLORS.SIGNAL_ARRHYTHMIA;
    ctx.fillRect(lx + 108, ly - 6, 15, 3);
    ctx.beginPath();
    ctx.arc(lx + 130, ly - 4, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('Arritmia (A)', lx + 138, ly);

    ctx.beginPath();
    ctx.arc(lx + 226, ly - 4, 4, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.SIGNAL_NORMAL;
    ctx.fill();
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('Pico', lx + 236, ly);

    ctx.beginPath();
    ctx.moveTo(lx + 268, ly - 6);
    ctx.lineTo(lx + 264, ly);
    ctx.lineTo(lx + 272, ly);
    ctx.closePath();
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fill();
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('Valle', lx + 278, ly);

    ctx.fillStyle = COLORS.IBI_TEXT;
    ctx.fillRect(lx + 310, ly - 5, 12, 2);
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('IBI', lx + 328, ly);

    ctx.fillStyle = COLORS.SCALE_TEXT;
    ctx.fillText('SWEEP 25mm/s · FILTRO 0.5–4 Hz · FUENTE PPG/RG', 420, ly);

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
      ctx.shadowColor = `rgba(255, 93, 93, ${0.3 + pulse * 0.6})`;
      ctx.shadowBlur = 12;
      ctx.fillStyle = COLORS.TEXT_DANGER;
      ctx.fillText(`⚠ ALARMAS: ${alarms.join(' ')}`, 826, ly);
      ctx.restore();
    } else {
      ctx.fillStyle = COLORS.TEXT_PRIMARY;
      ctx.fillText('● SIN ALARMAS', 826, ly);
    }
  }, []);

  // ---------- Sincronización de props ----------
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
      s.sum += bpm; s.n += 1;
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

  // ---------- Bucle de render ----------
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const now = Date.now();

    ensureBgCache(ctx);
    drawHeader(ctx, now);
    drawMetricsRow(ctx, now);
    draw3DStage(ctx, now);
    drawAnalyticsBand(ctx);
    drawFooter(ctx);

    ensureScanlineCache();
    if (scanlineCacheRef.current) ctx.drawImage(scanlineCacheRef.current, 0, 0);
  }, [ensureBgCache, ensureScanlineCache, drawHeader, drawMetricsRow, draw3DStage, drawAnalyticsBand, drawFooter]);

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
    lastArrhythmiaCountRef.current = 0;
    ibiDisplayRef.current = 0;
    hrvDisplayRef.current = { sdnn: 0, rmssd: 0 };
    bpmStatsRef.current = { min: 0, max: 0, sum: 0, n: 0 };
    bpmTrendRef.current = [];
    onReset();
  }, [onReset]);

  return (
    <div className="fixed inset-0 bg-slate-950">
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
