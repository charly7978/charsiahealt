export interface EcgSceneOptions {
  backgroundColor: number;
  fogNear: number;
  fogFar: number;
  pixelRatioCap: number;
  antialias: boolean;
  powerPreference: 'high-performance';
}

export interface RibbonGeometryData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint16Array;
  vertexCount: number;
}

export interface SweepBeamState {
  positionZ: number;
  intensity: number;
  lastPeakTime: number;
}

export interface EcgChannelConfig {
  baseY: number;
  amplitude: number;
  width: number;
  depth: number;
  timeWindowMs: number;
  depthSpanMs: number;
  color: number;
  emissive: number;
  ribbonSegments: number;
  ribbonSubSegments: number;
}

export interface MonitorLayout {
  stage: { x0: number; y0: number; x1: number; y1: number };
  ecgViewport: { y0: number; y1: number };
  ppgViewport: { y0: number; y1: number };
}