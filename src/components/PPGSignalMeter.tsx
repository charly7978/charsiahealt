import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Heart, Activity } from 'lucide-react';
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
  // Buffer interno 2x el viewport típico de móvil (420 CSS px de ancho).
  // Suficiente nitidez; ~3.5x menos píxeles que 1400x2800 para el llenado por frame.
  CANVAS_WIDTH: 840,
  CANVAS_HEIGHT: 1680,
  WINDOW_MS: 2800,
  TARGET_FPS: 30,
  BUFFER_SIZE: 400,
  PLOT_AREA: {
    LEFT: 80,
    RIGHT: 80,
    TOP: 130,
    BOTTOM: 60
  },
  COLORS: {
    BG: '#0a0f1a',
    GRID_MAJOR: 'rgba(34, 197, 94, 0.25)',
    GRID_MINOR: 'rgba(34, 197, 94, 0.1)',
    BASELINE: 'rgba(77, 215, 254, 0.35)',
    SIGNAL_NORMAL: '#34f5a1',
    SIGNAL_CORE: '#eafff6',
    SIGNAL_GLOW: 'rgba(52, 245, 161, 0.55)',
    SIGNAL_ARRHYTHMIA: '#ff5d5d',
    ARRHYTHMIA_GLOW: 'rgba(255, 93, 93, 0.55)',
    PEAK_NORMAL: '#3b82f6',
    PEAK_ARRHYTHMIA: '#ef4444',
    VALLEY_COLOR: '#94a3b8',
    TEXT_PRIMARY: '#34f5a1',
    TEXT_SECONDARY: '#9db4c8',
    TEXT_WARNING: '#fbbf24',
    TEXT_DANGER: '#ff5d5d',
    SCALE_TEXT: '#5c7488',
    ACCENT_CYAN: '#4dd7fe',
    GHOST_1: 'rgba(8, 80, 52, 0.5)',
    GHOST_2: 'rgba(4, 48, 34, 0.32)',
    SIGNAL_FILL_NORMAL: 'rgba(34, 197, 94, 0.12)',
    SIGNAL_FILL_ARR: 'rgba(255, 93, 93, 0.12)',
    SYSTOLIC_MARKER: '#60a5fa',
    DIASTOLIC_MARKER: '#818cf8',
    DICHROTIC_NOTCH: '#a78bfa',
    IBI_TEXT: '#67e8f9',
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
  const lastPeakTimeRef = useRef(0);
  const [showPulse, setShowPulse] = useState(false);
  
  const beatArrhythmiaRef = useRef(false);
  const lastArrhythmiaCountRef = useRef(0);
  const beatHistoryRef = useRef<{ isArrhythmia: boolean; time: number }[]>([]);
  const amplitudeStatsRef = useRef({ min: -50, max: 50, range: 100 });
  
  const ibiDisplayRef = useRef<number>(0);
  const hrvDisplayRef = useRef<{ sdnn: number; rmssd: number }>({ sdnn: 0, rmssd: 0 });
  const bpmStatsRef = useRef<{ min: number; max: number; sum: number; n: number }>({ min: 0, max: 0, sum: 0, n: 0 });
  const bpmTrendRef = useRef<{ t: number; bpm: number }[]>([]);
  const lastBpmSampleRef = useRef<number>(0);
  const lastHrvUpdateRef = useRef<number>(0);
  const lastBpmStatsUpdateRef = useRef<number>(0);

  const gridCacheRef = useRef<HTMLCanvasElement | null>(null);
  const gridDirtyRef = useRef(true);
  const scanlineCacheRef = useRef<HTMLCanvasElement | null>(null);

  const getPlotArea = useCallback(() => {
    const { CANVAS_WIDTH: W, CANVAS_HEIGHT: H, PLOT_AREA } = CONFIG;
    return {
      x: PLOT_AREA.LEFT,
      y: PLOT_AREA.TOP,
      width: W - PLOT_AREA.LEFT - PLOT_AREA.RIGHT,
      height: H - PLOT_AREA.TOP - PLOT_AREA.BOTTOM,
      centerY: PLOT_AREA.TOP + (H - PLOT_AREA.TOP - PLOT_AREA.BOTTOM) / 2
    };
  }, []);

  const drawGridToContext = useCallback((ctx: CanvasRenderingContext2D) => {
    const { CANVAS_WIDTH: W, CANVAS_HEIGHT: H, COLORS } = CONFIG;
    const plot = getPlotArea();
    
    // Fondo espacial profundo con bruma central
    const bgGrad = ctx.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, Math.max(W, H) / 1.15);
    bgGrad.addColorStop(0, '#0d1830');
    bgGrad.addColorStop(0.45, '#091020');
    bgGrad.addColorStop(1, '#03060c');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // Halo cian sutil superior (luz ambiental de cabecera)
    const topGlow = ctx.createRadialGradient(W * 0.5, -80, 0, W * 0.5, -80, W * 0.6);
    topGlow.addColorStop(0, 'rgba(40, 130, 200, 0.10)');
    topGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = topGlow;
    ctx.fillRect(0, 0, W, 400);

    // Área de trazado: gradiente vertical frío
    const innerGrad = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.height);
    innerGrad.addColorStop(0, 'rgba(0, 34, 22, 0.55)');
    innerGrad.addColorStop(0.5, 'rgba(2, 20, 14, 0.4)');
    innerGrad.addColorStop(1, 'rgba(0, 34, 22, 0.55)');
    ctx.fillStyle = innerGrad;
    ctx.fillRect(plot.x, plot.y, plot.width, plot.height);

    // Suelo en perspectiva (pseudo-3D): línea de horizonte interior baja del plot
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.width, plot.height);
    ctx.clip();
    const vpX = plot.x + plot.width / 2;
    const vpY = plot.y + plot.height + 150;
    ctx.strokeStyle = 'rgba(77, 215, 254, 0.055)';
    ctx.lineWidth = 1;
    // Horizontales recediendo (cada vez más juntas hacia abajo)
    for (let i = 1; i <= 7; i++) {
      const t = i / 8;
      const y = plot.centerY + 40 + Math.pow(t, 1.6) * (plot.y + plot.height - plot.centerY - 60);
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.width, y);
      ctx.stroke();
    }
    // Verticales convergentes al punto de fuga
    for (let i = 0; i <= 10; i++) {
      const xBottom = plot.x + (i / 10) * plot.width;
      const xTop = vpX + (xBottom - vpX) * 0.45;
      ctx.beginPath();
      ctx.moveTo(xTop, plot.y);
      ctx.lineTo(xBottom, plot.y + plot.height);
      ctx.stroke();
    }
    ctx.restore();

    // Rejilla estilo ECG: menor rojo (0.2s), mayor (1s), gruesa (5s) verde
    ctx.strokeStyle = 'rgba(200, 70, 70, 0.07)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let x = plot.x; x <= plot.x + plot.width; x += 20) {
      ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.height);
    }
    for (let y = plot.y; y <= plot.y + plot.height; y += 20) {
      ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.width, y);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(200, 70, 70, 0.17)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = plot.x; x <= plot.x + plot.width; x += 100) {
      ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.height);
    }
    for (let y = plot.y; y <= plot.y + plot.height; y += 100) {
      ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.width, y);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(34, 197, 94, 0.22)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let x = plot.x; x <= plot.x + plot.width; x += 500) {
      ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.height);
    }
    ctx.stroke();

    // Marcas de tiempo (segundos)
    ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
    ctx.font = '9px "SF Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    const secs = CONFIG.WINDOW_MS / 1000;
    for (let s = 0; s <= secs; s++) {
      const x = plot.x + plot.width - (s / secs) * plot.width;
      ctx.fillRect(x - 0.5, plot.y - 6, 1, 6);
      if (s % 1 === 0) {
        ctx.fillText(`${s}s`, x, plot.y - 9);
      }
    }

    // Línea base cian
    ctx.strokeStyle = COLORS.BASELINE;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([10, 6]);
    ctx.beginPath();
    ctx.moveTo(plot.x, plot.centerY);
    ctx.lineTo(plot.x + plot.width, plot.centerY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Marco del plot con resplandor exterior y esquinas
    ctx.shadowColor = 'rgba(34, 197, 94, 0.35)';
    ctx.shadowBlur = 14;
    ctx.strokeStyle = 'rgba(34, 197, 94, 0.5)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(plot.x, plot.y, plot.width, plot.height);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(34, 197, 94, 0.85)';
    ctx.lineWidth = 2;
    const ct = 22;
    ctx.beginPath();
    ctx.moveTo(plot.x, plot.y + ct); ctx.lineTo(plot.x, plot.y); ctx.lineTo(plot.x + ct, plot.y);
    ctx.moveTo(plot.x + plot.width - ct, plot.y); ctx.lineTo(plot.x + plot.width, plot.y); ctx.lineTo(plot.x + plot.width, plot.y + ct);
    ctx.moveTo(plot.x, plot.y + plot.height - ct); ctx.lineTo(plot.x, plot.y + plot.height); ctx.lineTo(plot.x + ct, plot.y + plot.height);
    ctx.moveTo(plot.x + plot.width, plot.y + plot.height - ct); ctx.lineTo(plot.x + plot.width, plot.y + plot.height); ctx.lineTo(plot.x + plot.width - ct, plot.y + plot.height);
    ctx.stroke();

    // Reflejo especular superior del panel de cristal
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.x + 2, plot.y + 0.5);
    ctx.lineTo(plot.x + plot.width - 2, plot.y + 0.5);
    ctx.stroke();
  }, [getPlotArea]);

  const ensureGridCache = useCallback((ctx: CanvasRenderingContext2D) => {
    if (!gridCacheRef.current || gridDirtyRef.current) {
      const offscreen = document.createElement('canvas');
      offscreen.width = CONFIG.CANVAS_WIDTH;
      offscreen.height = CONFIG.CANVAS_HEIGHT;
      const offCtx = offscreen.getContext('2d', { alpha: false })!;
      drawGridToContext(offCtx);
      gridCacheRef.current = offscreen;
      gridDirtyRef.current = false;
    }
    ctx.drawImage(gridCacheRef.current, 0, 0);
  }, [drawGridToContext]);

  const ensureScanlineCache = useCallback(() => {
    if (!scanlineCacheRef.current) {
      const offscreen = document.createElement('canvas');
      offscreen.width = CONFIG.CANVAS_WIDTH;
      offscreen.height = CONFIG.CANVAS_HEIGHT;
      const offCtx = offscreen.getContext('2d', { alpha: true })!;
      // Scanlines CRT muy sutiles
      offCtx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
      offCtx.lineWidth = 1;
      offCtx.beginPath();
      for (let y = 1; y < CONFIG.CANVAS_HEIGHT; y += 4) {
        offCtx.moveTo(0, y);
        offCtx.lineTo(CONFIG.CANVAS_WIDTH, y);
      }
      offCtx.stroke();
      // Viñeta
      const vg = offCtx.createRadialGradient(
        CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2, CONFIG.CANVAS_HEIGHT * 0.32,
        CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2, CONFIG.CANVAS_HEIGHT * 0.75
      );
      vg.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vg.addColorStop(1, 'rgba(0, 0, 0, 0.3)');
      offCtx.fillStyle = vg;
      offCtx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);
      scanlineCacheRef.current = offscreen;
    }
  }, []);

  const drawAmplitudeScale = useCallback((ctx: CanvasRenderingContext2D) => {
    const { COLORS } = CONFIG;
    const plot = getPlotArea();
    const stats = amplitudeStatsRef.current;
    
    ctx.font = '11px "SF Mono", Consolas, monospace';
    ctx.fillStyle = COLORS.SCALE_TEXT;
    ctx.textAlign = 'right';
    
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const y = plot.y + (i / steps) * plot.height;
      const val = stats.max - (i / steps) * stats.range;
      ctx.fillText(val.toFixed(0), plot.x - 8, y + 4);
      ctx.strokeStyle = COLORS.SCALE_TEXT;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.x - 5, y);
      ctx.lineTo(plot.x, y);
      ctx.stroke();
    }
    
    ctx.save();
    ctx.translate(15, plot.centerY);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.font = '10px "SF Mono", Consolas, monospace';
    ctx.fillText('AMPLITUD (μV)', 0, 0);
    ctx.restore();
  }, [getPlotArea]);

  const drawTimeScale = useCallback((ctx: CanvasRenderingContext2D) => {
    const { COLORS, WINDOW_MS } = CONFIG;
    const plot = getPlotArea();
    
    ctx.font = '10px "SF Mono", Consolas, monospace';
    ctx.fillStyle = COLORS.SCALE_TEXT;
    ctx.textAlign = 'center';
    
    const seconds = WINDOW_MS / 1000;
    for (let s = 0; s <= seconds; s++) {
      const x = plot.x + plot.width - (s / seconds) * plot.width;
      ctx.fillText(`${s}s`, x, plot.y + plot.height + 20);
      ctx.strokeStyle = COLORS.SCALE_TEXT;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, plot.y + plot.height);
      ctx.lineTo(x, plot.y + plot.height + 5);
      ctx.stroke();
    }
    
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.TEXT_PRIMARY;
    ctx.fillText('25mm/s', plot.x + plot.width, plot.y + plot.height + 40);
  }, [getPlotArea]);

  const drawGlassPanel = (
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    borderColor: string,
    headerColor: string
  ) => {
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, 'rgba(10, 20, 34, 0.86)');
    grad.addColorStop(1, 'rgba(4, 10, 20, 0.92)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 2, y + 1);
    ctx.lineTo(x + w - 2, y + 1);
    ctx.stroke();
    ctx.fillStyle = headerColor;
    ctx.fillRect(x, y, w, 4);
  };

  const drawVitalInfo = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const { CANVAS_WIDTH: W, COLORS } = CONFIG;
    const { bpm, spo2, arrhythmiaStatus, quality, rrIntervals, rawArrhythmiaData } = propsRef.current;
    
    const panelH = 122;
    const panelW = 165;
    const panelY = 2;
    const fontSize = {
      label: 'bold 13px "SF Mono", Consolas, monospace',
      value: 'bold 46px "SF Mono", Consolas, monospace',
      unit: '15px "SF Mono", Consolas, monospace',
      class: '11px "SF Mono", Consolas, monospace',
      small: '10px "SF Mono", Consolas, monospace',
    };

    const hrBorder = bpm > 0 && (bpm < 60 || bpm > 100) ? COLORS.TEXT_WARNING : COLORS.TEXT_PRIMARY;
    drawGlassPanel(ctx, 3, panelY, panelW, panelH, hrBorder, 'rgba(34, 197, 94, 0.25)');
    
    ctx.font = fontSize.label;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.textAlign = 'left';
    ctx.fillText('♥ FRECUENCIA', 10, panelY + 18);
    
    ctx.save();
    ctx.font = fontSize.value;
    ctx.fillStyle = bpm > 0 ? COLORS.TEXT_PRIMARY : COLORS.TEXT_SECONDARY;
    if (bpm > 0) {
      ctx.shadowColor = 'rgba(52, 245, 161, 0.45)';
      ctx.shadowBlur = 16;
    }
    ctx.fillText(bpm > 0 ? bpm.toString() : '--', 10, panelY + 66);
    ctx.restore();
    
    ctx.font = fontSize.unit;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('BPM', panelW - 36, panelY + 66);
    
    if (bpm > 0) {
      ctx.font = fontSize.class;
      let hrLabel = '';
      let hrColor = COLORS.TEXT_PRIMARY;
      if (bpm < 60) { hrLabel = 'BRADICARDIA'; hrColor = COLORS.TEXT_WARNING; }
      else if (bpm <= 100) { hrLabel = 'NORMAL'; hrColor = COLORS.TEXT_PRIMARY; }
      else { hrLabel = 'TAQUICARDIA'; hrColor = COLORS.TEXT_WARNING; }
      ctx.fillStyle = hrColor;
      ctx.fillText(hrLabel, 10, panelY + 86);
    }

    // Tachograma RR en vivo (datos reales de intervalos)
    const rr = rrIntervals || [];
    if (rr.length >= 2) {
      const rrRecent = rr.slice(-48);
      let rrMin = Infinity;
      let rrMax = -Infinity;
      for (const v of rrRecent) {
        if (v < rrMin) rrMin = v;
        if (v > rrMax) rrMax = v;
      }
      const rrRange = Math.max(80, rrMax - rrMin);
      ctx.font = '8px "SF Mono", Consolas, monospace';
      ctx.fillStyle = COLORS.TEXT_SECONDARY;
      ctx.textAlign = 'left';
      ctx.fillText('TACO RR', 10, panelY + 106);
      const tx = 52;
      const ty = panelY + 100;
      const tw = panelW - 62;
      const th = 15;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.fillRect(tx, ty, tw, th);
      ctx.strokeStyle = 'rgba(77, 215, 254, 0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(tx, ty, tw, th);
      ctx.beginPath();
      ctx.strokeStyle = COLORS.ACCENT_CYAN;
      ctx.lineWidth = 1.4;
      for (let i = 0; i < rrRecent.length; i++) {
        const px = tx + 2 + (i / (rrRecent.length - 1)) * (tw - 4);
        const py = ty + th - 3 - ((rrRecent[i] - rrMin) / rrRange) * (th - 6);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.fillStyle = COLORS.ACCENT_CYAN;
      ctx.fillRect(tx + tw - 4, ty + th - 5, 2, 5);
      ctx.font = '8px "SF Mono", Consolas, monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = COLORS.TEXT_SECONDARY;
      ctx.fillText(`${Math.round(rrMin)}–${Math.round(rrMax)}ms`, panelW - 4, panelY + 96);
    }
    
    const spo2Border = spo2 >= 95 ? COLORS.TEXT_PRIMARY : spo2 >= 90 ? COLORS.TEXT_WARNING : spo2 > 0 ? COLORS.TEXT_DANGER : COLORS.TEXT_SECONDARY;
    drawGlassPanel(ctx, W - panelW - 3, panelY, panelW, panelH, spo2Border, 'rgba(59, 130, 246, 0.25)');
    
    ctx.font = fontSize.label;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.textAlign = 'left';
    ctx.fillText('O₂ SATURACIÓN', W - panelW + 7, panelY + 18);
    
    ctx.font = fontSize.value;
    const spo2Color = spo2 >= 95 ? COLORS.TEXT_PRIMARY : spo2 >= 90 ? COLORS.TEXT_WARNING : spo2 > 0 ? COLORS.TEXT_DANGER : COLORS.TEXT_SECONDARY;
    ctx.fillStyle = spo2Color;
    ctx.fillText(spo2 > 0 ? spo2.toFixed(0) : '--', W - panelW + 7, panelY + 66);
    
    ctx.font = fontSize.unit;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('%', W - 22, panelY + 66);
    
    if (spo2 > 0) {
      ctx.font = fontSize.class;
      let spLabel = '';
      let spColor = COLORS.TEXT_PRIMARY;
      if (spo2 >= 95) { spLabel = 'NORMAL'; spColor = COLORS.TEXT_PRIMARY; }
      else if (spo2 >= 90) { spLabel = 'HIPOXEMIA LEVE'; spColor = COLORS.TEXT_WARNING; }
      else { spLabel = 'HIPOXEMIA'; spColor = COLORS.TEXT_DANGER; }
      ctx.fillStyle = spColor;
      ctx.fillText(spLabel, W - panelW + 7, panelY + 86);
    }

    const centerX = W / 2;
    const centerW = 250;
    const qBorder = quality > 60 ? COLORS.TEXT_PRIMARY : quality > 30 ? COLORS.TEXT_WARNING : COLORS.TEXT_DANGER;
    drawGlassPanel(ctx, centerX - centerW / 2, panelY, centerW, panelH, qBorder, 'rgba(77, 215, 254, 0.3)');
    
    ctx.font = '12px "SF Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('CALIDAD SEÑAL', centerX, panelY + 18);
    
    const barWidth = 210;
    const barHeight = 10;
    const barX = centerX - barWidth / 2;
    const barY = panelY + 24;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(barX, barY, barWidth, barHeight);
    
    const qGrad = ctx.createLinearGradient(barX, 0, barX + (quality / 100) * barWidth, 0);
    if (quality > 60) { qGrad.addColorStop(0, '#166534'); qGrad.addColorStop(1, '#34f5a1'); }
    else if (quality > 30) { qGrad.addColorStop(0, '#854d0e'); qGrad.addColorStop(1, '#fbbf24'); }
    else { qGrad.addColorStop(0, '#7f1d1d'); qGrad.addColorStop(1, '#ff5d5d'); }
    ctx.save();
    ctx.shadowColor = quality > 60 ? 'rgba(52, 245, 161, 0.5)' : quality > 30 ? 'rgba(251, 191, 36, 0.5)' : 'rgba(255, 93, 93, 0.5)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = qGrad;
    ctx.fillRect(barX, barY, (quality / 100) * barWidth, barHeight);
    ctx.restore();
    
    ctx.font = 'bold 13px "SF Mono", Consolas, monospace';
    ctx.fillStyle = quality > 60 ? COLORS.TEXT_PRIMARY : quality > 30 ? COLORS.TEXT_WARNING : COLORS.TEXT_DANGER;
    ctx.fillText(`${quality.toFixed(0)}%`, centerX, panelY + 52);
    
    const ibi = ibiDisplayRef.current;
    const hrv = hrvDisplayRef.current;
    ctx.font = fontSize.small;
    ctx.textAlign = 'left';
    
    ctx.fillStyle = COLORS.IBI_TEXT;
    ctx.fillText(`IBI: ${ibi > 0 ? ibi + 'ms' : '--'}`, centerX - centerW / 2 + 8, panelY + 68);
    
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText(`SDNN: ${hrv.sdnn > 0 ? hrv.sdnn + 'ms' : '--'}`, centerX - centerW / 2 + 8, panelY + 84);
    
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText(`RMSSD: ${hrv.rmssd > 0 ? hrv.rmssd + 'ms' : '--'}`, centerX + 20, panelY + 84);
    
    if (rrIntervals && rrIntervals.length > 0) {
      const lastRR = rrIntervals[rrIntervals.length - 1];
      ctx.fillStyle = COLORS.IBI_TEXT;
      ctx.textAlign = 'right';
      ctx.fillText(`RR: ${lastRR.toFixed(0)}ms`, centerX + centerW / 2 - 8, panelY + 68);
    }
    
    if (arrhythmiaStatus?.includes('ARRITMIA')) {
      const parts = arrhythmiaStatus.split('|');
      const count = parts.length > 1 ? parseInt(parts[1]) : 0;
      
      const pulse = (Math.sin(now / 100) + 1) / 2;
      ctx.fillStyle = `rgba(239, 68, 68, ${0.25 + pulse * 0.4})`;
      ctx.fillRect(W - panelW - 3, panelY + panelH + 4, panelW, 30);
      ctx.strokeStyle = COLORS.TEXT_DANGER;
      ctx.lineWidth = 2;
      ctx.strokeRect(W - panelW - 3, panelY + panelH + 4, panelW, 30);
      
      ctx.font = 'bold 14px "SF Mono", Consolas, monospace';
      ctx.fillStyle = COLORS.TEXT_DANGER;
      ctx.textAlign = 'center';
      ctx.fillText(`⚠ ARRITMIA x${count}`, W - panelW / 2 - 3, panelY + panelH + 22);
      
      if (rawArrhythmiaData && rawArrhythmiaData.rmssd > 0) {
        ctx.font = '10px "SF Mono", Consolas, monospace';
        ctx.fillStyle = 'rgba(255, 93, 93, 0.85)';
        ctx.fillText(`RMSSD: ${rawArrhythmiaData.rmssd.toFixed(0)}ms`, W - panelW / 2 - 3, panelY + panelH + 42);
      }
    }
  }, []);

  const drawClinicalPanel = useCallback((ctx: CanvasRenderingContext2D) => {
    const { CANVAS_WIDTH: W, CANVAS_HEIGHT: H, COLORS } = CONFIG;
    const { bpm, spo2, rrIntervals, perfusionIndex, pressure, elapsedTime } = propsRef.current;

    const panelH = 110;
    const panelY = H - panelH - 50;
    const panelX = 80;
    const panelW = W - 160;

    const grad = ctx.createLinearGradient(0, panelY, 0, panelY + panelH);
    grad.addColorStop(0, 'rgba(9, 18, 30, 0.94)');
    grad.addColorStop(1, 'rgba(3, 8, 16, 0.96)');
    ctx.fillStyle = grad;
    ctx.fillRect(panelX, panelY, panelW, panelH);
    ctx.shadowColor = 'rgba(34, 197, 94, 0.25)';
    ctx.shadowBlur = 10;
    ctx.strokeStyle = 'rgba(34, 197, 94, 0.4)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(panelX, panelY, panelW, panelH);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(panelX + 2, panelY + 1);
    ctx.lineTo(panelX + panelW - 2, panelY + 1);
    ctx.stroke();

    ctx.fillStyle = 'rgba(34, 197, 94, 0.12)';
    ctx.fillRect(panelX, panelY, panelW, 22);
    ctx.font = 'bold 11px "SF Mono", Consolas, monospace';
    ctx.fillStyle = COLORS.TEXT_PRIMARY;
    ctx.textAlign = 'left';
    ctx.fillText('● MONITOR · PARÁMETROS HEMODINÁMICOS', panelX + 10, panelY + 15);

    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const elapsedStr = (() => {
      const t = Math.max(0, Math.floor(elapsedTime || 0));
      const m = String(Math.floor(t / 60)).padStart(2, '0');
      const s = String(t % 60).padStart(2, '0');
      return `${m}:${s}`;
    })();
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText(`⏱ ${elapsedStr} · ${hh}:${mm}:${ss}`, panelX + panelW - 10, panelY + 15);

    const colW = panelW / 4;
    const rowY1 = panelY + 38;
    const rowY2 = panelY + 60;
    const rowY3 = panelY + 82;
    const rowY4 = panelY + 100;

    const drawCell = (cx: number, label: string, value: string, color: string, sub?: string) => {
      ctx.font = '9px "SF Mono", Consolas, monospace';
      ctx.fillStyle = COLORS.TEXT_SECONDARY;
      ctx.textAlign = 'left';
      ctx.fillText(label, cx + 10, rowY1);
      ctx.font = 'bold 22px "SF Mono", Consolas, monospace';
      ctx.fillStyle = color;
      ctx.fillText(value, cx + 10, rowY2);
      if (sub) {
        ctx.font = '9px "SF Mono", Consolas, monospace';
        ctx.fillStyle = COLORS.TEXT_SECONDARY;
        ctx.fillText(sub, cx + 10, rowY3);
      }
    };

    const stats = bpmStatsRef.current;
    const meanBpm = stats.n > 0 ? Math.round(stats.sum / stats.n) : 0;
    const meanRR = rrIntervals && rrIntervals.length > 0
      ? Math.round(rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length)
      : 0;

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

    const prColor = bpm <= 0 ? COLORS.TEXT_SECONDARY : (bpm < 60 || bpm > 100) ? COLORS.TEXT_WARNING : COLORS.TEXT_PRIMARY;
    drawCell(panelX + colW * 0, 'PR · PULSE RATE', bpm > 0 ? `${Math.round(bpm)}` : '--', prColor, 'lím 50–120 bpm');
    ctx.font = '9px "SF Mono", Consolas, monospace';
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText(`min ${stats.min || '--'}  max ${stats.max || '--'}  x̄ ${meanBpm || '--'}`, panelX + colW * 0 + 10, rowY4);

    const piVal = perfusionIndex || 0;
    const piColor = piVal >= 0.02 ? COLORS.TEXT_PRIMARY : piVal >= 0.005 ? COLORS.TEXT_WARNING : COLORS.TEXT_DANGER;
    drawCell(panelX + colW * 1, 'PI · PERFUSIÓN', piVal > 0 ? (piVal * 100).toFixed(2) : '--', piColor, '% AC/DC');
    const piBarX = panelX + colW * 1 + 10;
    const piBarY = rowY4 - 3;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(piBarX, piBarY, 110, 5);
    const piPct = Math.min(1, piVal / 0.05);
    ctx.fillStyle = piColor;
    ctx.fillRect(piBarX, piBarY, 110 * piPct, 5);

    const sys = pressure?.systolic || 0;
    const dia = pressure?.diastolic || 0;
    const map = sys > 0 && dia > 0 ? Math.round(dia + (sys - dia) / 3) : 0;
    const pp = sys > 0 && dia > 0 ? sys - dia : 0;
    const mapColor = map === 0 ? COLORS.TEXT_SECONDARY : (map < 65 || map > 110) ? COLORS.TEXT_WARNING : COLORS.TEXT_PRIMARY;
    drawCell(panelX + colW * 2, 'MAP · TAM', map > 0 ? `${map}` : '--', mapColor, 'mmHg · objetivo 70–105');
    ctx.font = '9px "SF Mono", Consolas, monospace';
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText(`PP ${pp > 0 ? pp + ' mmHg' : '--'}  ·  ${sys || '--'}/${dia || '--'}`, panelX + colW * 2 + 10, rowY4);

    const rrColor = respRate === 0 ? COLORS.TEXT_SECONDARY : (respRate < 12 || respRate > 20) ? COLORS.TEXT_WARNING : COLORS.TEXT_PRIMARY;
    drawCell(panelX + colW * 3, 'RESP (EST.)', respRate > 0 ? `${respRate}` : '--', rrColor, 'rpm · derivado RR');
    ctx.font = '9px "SF Mono", Consolas, monospace';
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText(`IBI x̄ ${meanRR > 0 ? meanRR + 'ms' : '--'}  ·  SpO₂ ${spo2 > 0 ? spo2.toFixed(0) + '%' : '--'}`, panelX + colW * 3 + 10, rowY4);

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(panelX + colW * i, panelY + 26);
      ctx.lineTo(panelX + colW * i, panelY + panelH - 6);
      ctx.stroke();
    }

    const trend = bpmTrendRef.current;
    if (trend.length >= 2) {
      const tx = panelX;
      const ty = panelY + panelH + 6;
      const tw = panelW;
      const th = 26;
      ctx.fillStyle = 'rgba(8, 16, 28, 0.85)';
      ctx.fillRect(tx, ty, tw, th);
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(tx, ty, tw, th);

      ctx.font = '9px "SF Mono", Consolas, monospace';
      ctx.fillStyle = COLORS.TEXT_SECONDARY;
      ctx.textAlign = 'left';
      ctx.fillText('TENDENCIA PR', tx + 6, ty + 11);

      let minB = trend[0].bpm;
      let maxB = trend[0].bpm;
      for (let i = 1; i < trend.length; i++) {
        if (trend[i].bpm < minB) minB = trend[i].bpm;
        if (trend[i].bpm > maxB) maxB = trend[i].bpm;
      }
      const range = Math.max(10, maxB - minB);
      ctx.beginPath();
      ctx.strokeStyle = COLORS.TEXT_PRIMARY;
      ctx.lineWidth = 1.5;
      ctx.shadowColor = 'rgba(52, 245, 161, 0.4)';
      ctx.shadowBlur = 6;
      for (let i = 0; i < trend.length; i++) {
        const p = trend[i];
        const px = tx + 90 + (i / (trend.length - 1)) * (tw - 100);
        const py = ty + th - 4 - ((p.bpm - minB) / range) * (th - 8);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.textAlign = 'right';
      ctx.fillStyle = COLORS.TEXT_SECONDARY;
      ctx.fillText(`${Math.round(minB)}–${Math.round(maxB)} bpm`, tx + tw - 6, ty + 11);
    }

    ctx.font = '9px "SF Mono", Consolas, monospace';
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.textAlign = 'left';
    const fy = H - 8;
    ctx.fillText('SWEEP 25mm/s   GAIN ×1.0   FILTRO 0.5–4 Hz   FUENTE PPG/RG', panelX + 10, fy);
    ctx.textAlign = 'right';
    const alarms: string[] = [];
    if (bpm > 0 && (bpm < 50 || bpm > 120)) alarms.push(`HR!`);
    if (spo2 > 0 && spo2 < 92) alarms.push(`SpO₂!`);
    if (map > 0 && (map < 65 || map > 110)) alarms.push(`MAP!`);
    if (alarms.length > 0) {
      const pulse = (Math.sin(Date.now() / 180) + 1) / 2;
      ctx.save();
      ctx.shadowColor = `rgba(255, 93, 93, ${0.3 + pulse * 0.6})`;
      ctx.shadowBlur = 12;
      ctx.fillStyle = COLORS.TEXT_DANGER;
      ctx.fillText(`⚠ ALARMAS: ${alarms.join(' ')}`, panelX + panelW - 10, fy);
      ctx.restore();
    } else {
      ctx.fillStyle = COLORS.TEXT_PRIMARY;
      ctx.fillText('● SIN ALARMAS', panelX + panelW - 10, fy);
    }
  }, []);

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
    if (isPeak && isFingerDetected) {
      const now = Date.now();
      if (now - lastPeakTimeRef.current > 250) {
        lastPeakTimeRef.current = now;
        setShowPulse(true);
        setTimeout(() => setShowPulse(false), 120);
      }
    }
  }, [isPeak, isFingerDetected]);

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

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const buffer = dataBufferRef.current;
    if (!canvas || !buffer) {
      return;
    }
    
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      return;
    }
    
    const now = Date.now();

    const { value: signalValue, isFingerDetected: detected, arrhythmiaStatus: arrStatus, preserveResults: preserve, isPeak: peak } = propsRef.current;
    const plot = getPlotArea();
    const { WINDOW_MS, COLORS } = CONFIG;
    
    ensureGridCache(ctx);
    
    // Los paneles deben redibujarse en CADA frame: ensureGridCache repinta el
    // fondo opaco, que borraría lo dibujado en el frame anterior.
    drawAmplitudeScale(ctx);
    drawTimeScale(ctx);
    drawVitalInfo(ctx, now);
    drawClinicalPanel(ctx);
    
    if (preserve && !detected) {
      ensureScanlineCache();
      if (scanlineCacheRef.current) ctx.drawImage(scanlineCacheRef.current, 0, 0);
      return;
    }
    
    const scaledValue = signalValue * 2;
    
    if (peak) {
      const currentCount = arrStatus ? parseInt(arrStatus.split('|')[1] || '0') : 0;
      if (currentCount > lastArrhythmiaCountRef.current) {
        beatArrhythmiaRef.current = true;
        lastArrhythmiaCountRef.current = currentCount;
        
        const { rrIntervals: rr } = propsRef.current;
        const lastRR = rr && rr.length > 0 ? rr[rr.length - 1] : 800;
        const retroDuration = Math.min(Math.max(lastRR, 400), 1500);
        buffer.markArrhythmiaBack(retroDuration);
      } else {
        beatArrhythmiaRef.current = false;
      }
      beatHistoryRef.current.push({ isArrhythmia: beatArrhythmiaRef.current, time: now });
      if (beatHistoryRef.current.length > 20) {
        beatHistoryRef.current = beatHistoryRef.current.slice(-20);
      }
    }
    const currentIsArrhythmia = beatArrhythmiaRef.current;
    
    buffer.push({
      time: now,
      value: scaledValue,
      isArrhythmia: currentIsArrhythmia
    });
    
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
    
    if (points.length > 2) {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      
      const pathCoords: { x: number; y: number; isArr: boolean }[] = [];
      
      for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        const age = now - pt.time;
        if (age > WINDOW_MS) continue;
        
        const x = plot.x + plot.width - (age * plot.width / WINDOW_MS);
        const normalizedY = (stats.max - pt.value) / stats.range;
        const y = plot.y + normalizedY * plot.height;
        
        if (x < plot.x || x > plot.x + plot.width) continue;
        pathCoords.push({ x, y, isArr: pt.isArrhythmia });
      }
      
      if (pathCoords.length > 2) {
        // --- REFLEJO 3D: espejo de la onda bajo la línea base con desvanecido ---
        ctx.save();
        ctx.beginPath();
        ctx.rect(plot.x, plot.y, plot.width, plot.height);
        ctx.clip();
        const reflGrad = ctx.createLinearGradient(0, plot.centerY, 0, plot.y + plot.height);
        reflGrad.addColorStop(0, 'rgba(52, 245, 161, 0.16)');
        reflGrad.addColorStop(0.35, 'rgba(52, 245, 161, 0.06)');
        reflGrad.addColorStop(1, 'rgba(52, 245, 161, 0)');
        ctx.strokeStyle = reflGrad;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        let started = false;
        for (const c of pathCoords) {
          const my = 2 * plot.centerY - c.y;
          if (my < plot.y + plot.height) {
            if (!started) { ctx.moveTo(c.x, my); started = true; }
            else ctx.lineTo(c.x, my);
          } else {
            started = false;
          }
        }
        ctx.stroke();
        ctx.restore();
        
        // --- RELLENO de área bajo la onda ---
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pathCoords[0].x, plot.centerY);
        for (const c of pathCoords) {
          ctx.lineTo(c.x, c.y);
        }
        ctx.lineTo(pathCoords[pathCoords.length - 1].x, plot.centerY);
        ctx.closePath();
        
        const fillGrad = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.height);
        fillGrad.addColorStop(0, 'rgba(34, 197, 94, 0.12)');
        fillGrad.addColorStop(0.5, 'rgba(34, 197, 94, 0.04)');
        fillGrad.addColorStop(1, 'rgba(34, 197, 94, 0.0)');
        ctx.fillStyle = fillGrad;
        ctx.fill();
        ctx.restore();
        
        // Segmentación de corridas normales / arritmia
        const runs: { pts: { x: number; y: number }[]; arr: boolean }[] = [];
        let currentRun: { x: number; y: number }[] = [];
        let currentArr = pathCoords[0].isArr;
        for (const c of pathCoords) {
          if (c.isArr === currentArr) {
            currentRun.push(c);
          } else {
            if (currentRun.length > 1) runs.push({ pts: currentRun, arr: currentArr });
            currentRun = [c];
            currentArr = c.isArr;
          }
        }
        if (currentRun.length > 1) runs.push({ pts: currentRun, arr: currentArr });
        
        const arrRuns = runs.filter(r => r.arr);
        for (const seg of arrRuns) {
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(seg.pts[0].x, plot.centerY);
          for (const c of seg.pts) ctx.lineTo(c.x, c.y);
          ctx.lineTo(seg.pts[seg.pts.length - 1].x, plot.centerY);
          ctx.closePath();
          const arrFill = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.height);
          arrFill.addColorStop(0, 'rgba(255, 93, 93, 0.15)');
          arrFill.addColorStop(0.5, 'rgba(255, 93, 93, 0.05)');
          arrFill.addColorStop(1, 'rgba(255, 93, 93, 0.0)');
          ctx.fillStyle = arrFill;
          ctx.fill();
          ctx.restore();
        }
        
        // --- EXTRUSIÓN 3D: copias recediendo en profundidad ---
        const ghostPasses = [
          { dy: 26, style: COLORS.GHOST_2, width: 2 },
          { dy: 13, style: COLORS.GHOST_1, width: 2.4 }
        ];
        ctx.save();
        ctx.beginPath();
        ctx.rect(plot.x, plot.y, plot.width, plot.height);
        ctx.clip();
        for (const gp of ghostPasses) {
          ctx.strokeStyle = gp.style;
          ctx.lineWidth = gp.width;
          ctx.beginPath();
          let gstarted = false;
          for (const c of pathCoords) {
            const gy = Math.min(plot.y + plot.height - 2, c.y + gp.dy);
            if (!gstarted) { ctx.moveTo(c.x, gy); gstarted = true; }
            else ctx.lineTo(c.x, gy);
          }
          ctx.stroke();
        }
        ctx.restore();
        
        const strokePass = (arr: boolean, width: number, alpha: number, blur: number, useCore = false) => {
          for (const run of runs) {
            if (run.arr !== arr) continue;
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(run.pts[0].x, run.pts[0].y);
            for (let i = 1; i < run.pts.length; i++) ctx.lineTo(run.pts[i].x, run.pts[i].y);
            ctx.globalAlpha = alpha;
            if (blur > 0) {
              ctx.shadowColor = arr ? COLORS.ARRHYTHMIA_GLOW : COLORS.SIGNAL_GLOW;
              ctx.shadowBlur = blur;
            }
            ctx.strokeStyle = arr ? (useCore ? '#ffd9d9' : COLORS.SIGNAL_ARRHYTHMIA) : (useCore ? COLORS.SIGNAL_CORE : COLORS.SIGNAL_NORMAL);
            ctx.lineWidth = width;
            ctx.stroke();
            ctx.restore();
          }
        };
        
        // Halo exterior difuso
        strokePass(false, 8, 0.22, 22);
        strokePass(true, 8, 0.22, 22);
        // Trazo principal fosforescente
        strokePass(false, 2.6, 1, 12);
        strokePass(true, 2.6, 1, 12);
        // Núcleo blanco-caliente
        strokePass(false, 1.1, 0.85, 0, true);
        strokePass(true, 1.1, 0.85, 0, true);
        
        // --- BARRA DE BARRIDO en el borde actual (sweep) ---
        const edgeX = plot.x + plot.width;
        const beamW = 90;
        const beamGrad = ctx.createLinearGradient(edgeX - beamW, 0, edgeX, 0);
        const beamPulse = 0.16 + 0.06 * Math.sin(now / 260);
        beamGrad.addColorStop(0, `rgba(52, 245, 161, 0)`);
        beamGrad.addColorStop(1, `rgba(52, 245, 161, ${beamPulse})`);
        ctx.fillStyle = beamGrad;
        ctx.fillRect(edgeX - beamW, plot.y, beamW, plot.height);
        ctx.save();
        ctx.shadowColor = 'rgba(52, 245, 161, 0.8)';
        ctx.shadowBlur = 10;
        ctx.fillStyle = `rgba(52, 245, 161, ${0.35 + 0.15 * Math.sin(now / 260)})`;
        ctx.fillRect(edgeX - 1.5, plot.y, 1.5, plot.height);
        ctx.restore();
        
        const peaks: { x: number; y: number; isArrhythmia: boolean; time: number }[] = [];
        const valleys: { x: number; y: number }[] = [];
        const history = beatHistoryRef.current;
        const visibleBeats: { time: number; x: number; y: number; isArrhythmia: boolean }[] = [];
        
        for (const beat of history) {
          const age = now - beat.time;
          if (age > WINDOW_MS || age < 0) continue;
          
          const x = plot.x + plot.width - (age * plot.width / WINDOW_MS);
          if (x < plot.x || x > plot.x + plot.width) continue;
          
          let closestPt: PPGDataPoint | null = null;
          let minDist = Infinity;
          for (let j = 0; j < points.length; j++) {
            const pt = points[j];
            const dist = Math.abs(pt.time - beat.time);
            if (dist < minDist) { minDist = dist; closestPt = pt; }
          }
          
          if (closestPt && minDist < 200) {
            const normalizedY = (stats.max - closestPt.value) / stats.range;
            const y = plot.y + normalizedY * plot.height;
            peaks.push({ x, y, isArrhythmia: beat.isArrhythmia, time: beat.time });
            visibleBeats.push({ time: beat.time, x, y, isArrhythmia: beat.isArrhythmia });
          }
        }
        
        for (let b = 0; b < visibleBeats.length - 1; b++) {
          const t0 = visibleBeats[b].time;
          const t1 = visibleBeats[b + 1].time;
          let minVal = Infinity;
          let minPt: PPGDataPoint | null = null;
          for (let j = 0; j < points.length; j++) {
            const pt = points[j];
            if (pt.time > t0 && pt.time < t1 && pt.value < minVal) {
              minVal = pt.value;
              minPt = pt;
            }
          }
          if (minPt) {
            const age2 = now - minPt.time;
            const vx = plot.x + plot.width - (age2 * plot.width / WINDOW_MS);
            const vy = plot.y + ((stats.max - minPt.value) / stats.range) * plot.height;
            if (vx >= plot.x && vx <= plot.x + plot.width) {
              valleys.push({ x: vx, y: vy });
            }
          }
        }
        
        for (let i = 0; i < peaks.length - 1; i++) {
          const p1 = peaks[i];
          const p2 = peaks[i + 1];
          const ibiMs = Math.abs(p1.time - p2.time);
          if (ibiMs > 0 && ibiMs < 3000) {
            const midX = (p1.x + p2.x) / 2;
            const topY = Math.min(p1.y, p2.y) - 28;
            
            ctx.strokeStyle = 'rgba(103, 232, 249, 0.45)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(p1.x, topY + 8);
            ctx.lineTo(p1.x, topY);
            ctx.lineTo(p2.x, topY);
            ctx.lineTo(p2.x, topY + 8);
            ctx.stroke();
            
            ctx.font = '9px "SF Mono", Consolas, monospace';
            ctx.fillStyle = COLORS.IBI_TEXT;
            ctx.textAlign = 'center';
            ctx.fillText(`${ibiMs}ms`, midX, topY - 3);
          }
        }
        
        peaks.forEach(p => {
          const color = p.isArrhythmia ? COLORS.PEAK_ARRHYTHMIA : COLORS.SIGNAL_NORMAL;
          
          ctx.save();
          ctx.strokeStyle = p.isArrhythmia ? 'rgba(255, 93, 93, 0.35)' : 'rgba(34, 197, 94, 0.25)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(p.x, plot.y);
          ctx.lineTo(p.x, plot.y + plot.height);
          ctx.stroke();
          ctx.restore();
          
          // Esfera 3D del pico: gradiente radial + brillo especular
          const r = p.isArrhythmia ? 9 : 7;
          const sg = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.35, r * 0.1, p.x, p.y, r);
          sg.addColorStop(0, p.isArrhythmia ? '#ffe1e1' : '#d8ffe9');
          sg.addColorStop(0.45, color);
          sg.addColorStop(1, p.isArrhythmia ? '#7f1d1d' : '#0f5132');
          ctx.save();
          ctx.shadowColor = p.isArrhythmia ? 'rgba(255, 93, 93, 0.8)' : 'rgba(52, 245, 161, 0.8)';
          ctx.shadowBlur = 14;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fillStyle = sg;
          ctx.fill();
          ctx.restore();
          
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          
          ctx.font = 'bold 11px "SF Mono", Consolas, monospace';
          ctx.fillStyle = p.isArrhythmia ? COLORS.TEXT_DANGER : COLORS.SIGNAL_NORMAL;
          ctx.textAlign = 'center';
          ctx.fillText(p.isArrhythmia ? 'A' : 'N', p.x, p.y - 16);
          
          if (p.isArrhythmia) {
            const alpha = (Math.sin(now / 80) + 1) / 2;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 18, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(255, 93, 93, ${0.3 + alpha * 0.5})`;
            ctx.lineWidth = 2.5;
            ctx.stroke();
            
            ctx.beginPath();
            ctx.arc(p.x, p.y, 24, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(255, 93, 93, ${0.1 + alpha * 0.2})`;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        });
        
        valleys.forEach(v => {
          ctx.beginPath();
          ctx.moveTo(v.x, v.y + 3);
          ctx.lineTo(v.x - 4, v.y + 10);
          ctx.lineTo(v.x + 4, v.y + 10);
          ctx.closePath();
          ctx.fillStyle = COLORS.VALLEY_COLOR;
          ctx.fill();
          
          ctx.font = '8px "SF Mono", Consolas, monospace';
          ctx.fillStyle = COLORS.VALLEY_COLOR;
          ctx.textAlign = 'center';
          ctx.fillText('V', v.x, v.y + 22);
        });
      }
      
      const beatHistory = beatHistoryRef.current;
      if (beatHistory.length > 0) {
        const histX = plot.x;
        const histY = plot.y + plot.height + 30;
        const dotRadius = 7;
        const dotSpacing = 18;
        const totalWidth = beatHistory.length * dotSpacing;
        const startX = histX + (plot.width - totalWidth) / 2;
        
        ctx.fillStyle = 'rgba(6, 12, 24, 0.88)';
        const panelPad = 8;
        ctx.fillRect(startX - panelPad, histY - dotRadius - panelPad, totalWidth + panelPad * 2, dotRadius * 2 + panelPad * 2 + 12);
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.3)';
        ctx.lineWidth = 1;
        ctx.strokeRect(startX - panelPad, histY - dotRadius - panelPad, totalWidth + panelPad * 2, dotRadius * 2 + panelPad * 2 + 12);
        
        ctx.font = '8px "SF Mono", Consolas, monospace';
        ctx.fillStyle = COLORS.TEXT_SECONDARY;
        ctx.textAlign = 'center';
        ctx.fillText('HISTORIAL DE LATIDOS', startX + totalWidth / 2, histY - dotRadius - 1);
        
        const arrCount = beatHistory.filter(b => b.isArrhythmia).length;
        const normalCount = beatHistory.length - arrCount;
        ctx.textAlign = 'right';
        ctx.fillStyle = COLORS.SIGNAL_NORMAL;
        ctx.fillText(`N:${normalCount}`, startX + totalWidth + panelPad - 2, histY - dotRadius - 1);
        ctx.fillStyle = arrCount > 0 ? COLORS.SIGNAL_ARRHYTHMIA : COLORS.TEXT_SECONDARY;
        ctx.fillText(`A:${arrCount}`, startX - 2, histY - dotRadius - 1);
        ctx.textAlign = 'center';
        
        for (let i = 0; i < beatHistory.length; i++) {
          const beat = beatHistory[i];
          const cx = startX + i * dotSpacing + dotSpacing / 2;
          const cy = histY + 6;
          
          if (beat.isArrhythmia) {
            ctx.beginPath();
            ctx.arc(cx, cy, dotRadius + 3, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 93, 93, 0.25)';
            ctx.fill();
          }
          
          const dg = ctx.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, dotRadius);
          dg.addColorStop(0, '#ffffff');
          dg.addColorStop(0.4, beat.isArrhythmia ? COLORS.SIGNAL_ARRHYTHMIA : COLORS.SIGNAL_NORMAL);
          dg.addColorStop(1, beat.isArrhythmia ? '#7f1d1d' : '#0f5132');
          ctx.beginPath();
          ctx.arc(cx, cy, dotRadius, 0, Math.PI * 2);
          ctx.fillStyle = dg;
          ctx.fill();
          
          ctx.font = 'bold 7px "SF Mono", Consolas, monospace';
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.fillText(`${i + 1}`, cx, cy + 3);
        }
      }
    }
    
    // Overlay CRT: scanlines + viñeta por encima de todo el canvas
    ensureScanlineCache();
    if (scanlineCacheRef.current) ctx.drawImage(scanlineCacheRef.current, 0, 0);
    
    const legendY = CONFIG.CANVAS_HEIGHT - 15;
    ctx.font = '9px "SF Mono", Consolas, monospace';
    ctx.textAlign = 'left';
    const lx = CONFIG.PLOT_AREA.LEFT;
    
    ctx.fillStyle = COLORS.SIGNAL_NORMAL;
    ctx.fillRect(lx, legendY - 6, 15, 3);
    ctx.beginPath();
    ctx.arc(lx + 22, legendY - 4, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('Normal (N)', lx + 30, legendY);
    
    ctx.fillStyle = COLORS.SIGNAL_ARRHYTHMIA;
    ctx.fillRect(lx + 110, legendY - 6, 15, 3);
    ctx.beginPath();
    ctx.arc(lx + 132, legendY - 4, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('Arritmia (A)', lx + 140, legendY);
    
    ctx.beginPath();
    ctx.arc(lx + 230, legendY - 4, 4, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.PEAK_NORMAL;
    ctx.fill();
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('Pico', lx + 240, legendY);
    
    ctx.beginPath();
    ctx.moveTo(lx + 275, legendY - 6);
    ctx.lineTo(lx + 271, legendY);
    ctx.lineTo(lx + 279, legendY);
    ctx.closePath();
    ctx.fillStyle = COLORS.VALLEY_COLOR;
    ctx.fill();
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('Valle', lx + 285, legendY);
    
    ctx.fillStyle = COLORS.IBI_TEXT;
    ctx.fillRect(lx + 320, legendY - 5, 12, 2);
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('IBI', lx + 338, legendY);
  }, [ensureGridCache, ensureScanlineCache, drawAmplitudeScale, drawTimeScale, drawVitalInfo, drawClinicalPanel, getPlotArea]);

  useEffect(() => {
    if (isRunningRef.current) return;
    isRunningRef.current = true;
    
    // Bucle único con throttle: la señal se pinta a TARGET_FPS y los paneles
    // estáticos se refrescan a media frecuencia dentro de render().
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
    gridDirtyRef.current = true;
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

      <div className="absolute top-0 left-0 p-2 z-10 flex items-center gap-2" style={{ top: '6px', left: '138px' }}>
        <div className={`p-1.5 rounded-full transition-all duration-100 ${
          showPulse ? 'bg-red-500/30 scale-110' : 'bg-emerald-500/20'
        }`}>
          <Heart 
            className={`w-4 h-4 transition-all duration-100 ${
              showPulse ? 'text-red-400 scale-110' : 'text-emerald-400'
            }`}
            fill={showPulse ? 'currentColor' : 'none'}
          />
        </div>
        <Activity className="w-3.5 h-3.5 text-emerald-400" />
        <span className="text-[10px] font-mono text-emerald-400/80">PPG MONITOR v4</span>
        {isMonitoring && (
          <span className="flex items-center gap-1 text-[9px] font-mono text-red-400">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            LIVE
          </span>
        )}
      </div>

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
