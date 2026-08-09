import type * as THREE from 'three';

/** Opciones de la escena WebGL (renderer, cámara, niebla, DPR). */
export interface EcgSceneOptions {
  /** Color de fondo y niebla (0x000a05). */
  backgroundColor: number;
  fogNear: number;
  fogFar: number;
  /** Cap de pixel ratio: 2 móvil · 1.5 desktop. */
  pixelRatioCap: number;
  antialias: boolean;
  powerPreference: 'high-performance';
  /** Renderer inyectable para tests (por defecto WebGLRenderer). */
  renderer?: THREE.WebGLRenderer;
}

/** Datos de la geometría de una cinta (BufferGeometry). */
export interface RibbonGeometryData {
  positions: Float32Array; // x,y,z por vértice
  normals: Float32Array;
  uvs: Float32Array; // u: posición en ventana, v: canal
  colors: Float32Array; // por vértice (tinte por ritmo/arr)
  indices: Uint16Array; // triángulos
  vertexCount: number;
  /** columnas de vértices (subSegmentos + 1). */
  columns: number;
  /** filas de vértices (segmentos + 1). */
  rows: number;
}

/** Estado del haz de barrido. */
export interface SweepBeamState {
  positionZ: number; // avanza por la ventana [-depth .. 0]
  intensity: number; // pulso por latido
  lastPeakTime: number;
}

/** Configuración de un canal de la cinta (ECG superior / PPG inferior). */
export interface EcgChannelConfig {
  /** Centro vertical del canal en unidades de mundo. */
  baseY: number;
  /** Gama de alturas del canal en unidades de mundo. */
  amplitude: number;
  /** Ancho del canal en unidades de mundo. */
  width: number;
  /** Profundidad de la ventana en unidades de mundo. */
  depth: number;
  /** Ventana temporal visible (ms). */
  timeWindowMs: number;
  /** Span de profundidad perceptible (ms) — persiste el "caminito" en Z. */
  depthSpanMs: number;
  /** Color base del canal. */
  color: number;
  emissive: number;
  /** Resolución longitudinal (≥ 220). */
  ribbonSegments: number;
  /** Resolución transversal (4). */
  ribbonSubSegments: number;
}

/** Layout del monitor (coordenadas del overlay 2D). */
export interface MonitorLayout {
  stage: { x0: number; y0: number; x1: number; y1: number };
  ecgViewport: { y0: number; y1: number };
  ppgViewport: { y0: number; y1: number };
}

/** Punto de señal que consume la cinta. */
export interface RibbonPoint {
  t: number;
  y: number;
  rhythm: string;
  isArr: boolean;
  isPeak: boolean;
}

/** Un punto del buffer del sintetizador ECG. */
export interface ECGPoint {
  time: number;
  y: number;
  isPeak: boolean;
  rhythm: string;
  isArrhythmia: boolean;
}
