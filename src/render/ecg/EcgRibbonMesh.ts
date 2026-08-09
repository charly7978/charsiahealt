import * as THREE from 'three';
import type { EcgChannelConfig, RibbonPoint } from './types';

/** Colores en espacio lineal para tintes por vértice. */
const COLOR_PEAK = new THREE.Color(0xffffff);
const COLOR_ARR = new THREE.Color(0xff3344);
const COLOR_NS = new THREE.Color(1, 1, 1); // tinte neutro (se multiplica)

/**
 * Malla de cinta 3D (ribbon) para un canal ECG/PPG.
 *
 * La geometría es un ring buffer de vértices: cada frame `advance` desplaza
 * los vértices hacia -Z (persistencia en profundidad) y recicla los que
 * salen de la ventana con el punto más reciente (head). `pushPoint` encola
 * puntos en el head; el avance temporal se resuelve en `advance`.
 */
export class EcgRibbonMesh {
  readonly channel: EcgChannelConfig;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshPhongMaterial;
  readonly mesh: THREE.Mesh;

  /** Ventana de puntos (FIFO), convertidos a worldY en el push. */
  private readonly head: RibbonPoint[] = [];

  /** Columnas reales de la geometría (subSegmentos + 1). */
  private readonly cols: number;
  /** Filas reales (segmentos + 1). */
  private readonly rows: number;
  private readonly vertexCount: number;

  /** Último tiempo procesado (avance). */
  private nowMs = 0;
  /** Última posición Z del head (frente de la cinta). */
  private headZ = 0;

  /** Pulso de iluminación por latido (0..1). */
  private beatPulse = 0;

  constructor(scene: THREE.Scene, channel: EcgChannelConfig) {
    this.channel = channel;

    this.cols = channel.ribbonSubSegments + 1;
    this.rows = channel.ribbonSegments + 1;
    this.vertexCount = this.cols * this.rows;

    // --- Geometría con ring buffer de vértices ---
    const positions = new Float32Array(this.vertexCount * 3);
    const normals = new Float32Array(this.vertexCount * 3);
    const uvs = new Float32Array(this.vertexCount * 2);
    const colors = new Float32Array(this.vertexCount * 3);
    const indices = new Uint16Array((channel.ribbonSegments * channel.ribbonSubSegments) * 6);

    // Inicializar: cinta plana a lo largo del eje X (ancho), en Z distribuido
    // entre [-channel.depth, 0], centrada en baseY.
    const halfW = channel.width / 2;
    for (let r = 0; r < this.rows; r++) {
      const v = r / channel.ribbonSegments;
      const z = -channel.depth + v * channel.depth;
      for (let c = 0; c < this.cols; c++) {
        const u = c / channel.ribbonSubSegments;
        const x = -halfW + u * channel.width;
        const idx = (r * this.cols + c) * 3;
        positions[idx] = x;
        positions[idx + 1] = channel.baseY;
        positions[idx + 2] = z;
        normals[idx] = 0;
        normals[idx + 1] = 1;
        normals[idx + 2] = 0;
        uvs[(r * this.cols + c) * 2] = u;
        uvs[(r * this.cols + c) * 2 + 1] = v;
      }
    }

    // Índices (dos triángulos por celda).
    let i = 0;
    for (let r = 0; r < channel.ribbonSegments; r++) {
      for (let c = 0; c < channel.ribbonSubSegments; c++) {
        const a = r * this.cols + c;
        const b = a + 1;
        const c1 = a + this.cols;
        const d = c1 + 1;
        indices[i++] = a; indices[i++] = c1; indices[i++] = b;
        indices[i++] = b; indices[i++] = c1; indices[i++] = d;
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    // --- Material ---
    this.material = new THREE.MeshPhongMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      emissive: new THREE.Color(channel.emissive),
      emissiveIntensity: 0.35,
      shininess: 18,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** Encola un punto nuevo en el head de la cinta. */
  pushPoint(point: RibbonPoint): void {
    this.head.push(point);
    // Límite de retención: puntos con más de 3 ventanas de antigüedad se descartan.
    if (this.head.length > this.rows * 2) {
      this.head.splice(0, this.head.length - this.rows * 2);
    }
  }

  /** Vacía la cola de puntos pendientes (reset del monitor). */
  clearHeads(): void {
    this.head.length = 0;
  }

  /** Desplaza la geometría: mueve los vértices hacia -Z y recicla el head. */
  advance(nowMs: number): void {
    if (this.nowMs === 0) {
      this.nowMs = nowMs;
      this.headZ = 0; // la cinta arranca en el frente
      return;
    }
    const dt = Math.max(0, nowMs - this.nowMs);
    this.nowMs = nowMs;

    const { timeWindowMs, depthSpanMs, depth, amplitude, baseY, width } = this.channel;
    const pos = this.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.geometry.attributes.color as THREE.BufferAttribute;
    const positions = pos.array as Float32Array;
    const colors = col.array as Float32Array;
    const halfW = width / 2;

    // 1) Mover todos los vértices hacia -Z según la velocidad de barrido.
    const zPerMs = depth / timeWindowMs;
    const dz = dt * zPerMs;
    this.headZ -= dz;
    for (let i = 0; i < this.vertexCount; i++) {
      positions[i * 3 + 2] -= dz;
    }

    // 2) Reciclar TODAS las filas que salieron por detrás: cada fila consume
    //    el siguiente punto pendiente del head (FIFO) y se reubica en el
    //    frente. Así la forma temporal de la señal queda grabada en la cinta.
    for (let r = 0; r < this.rows; r++) {
      const rowBaseIdx = r * this.cols;
      if (positions[rowBaseIdx * 3 + 2] >= -depth) continue;

      const pending = this.head.shift();
      const rawY = pending ? pending.y : 0;
      const clampY = Math.max(-1.15, Math.min(1.15, rawY));
      const worldY = baseY + clampY * amplitude;
      for (let c = 0; c < this.cols; c++) {
        const idx = (rowBaseIdx + c) * 3;
        positions[idx + 1] = worldY;
        positions[idx + 2] = this.headZ; // frente
      }
    }

    // 3) Actualizar normales (apuntan hacia +Y con leve inclinación por la
    //    pendiente de la señal — suficiente para la luz direccional).
    const normals = (this.geometry.attributes.normal as THREE.BufferAttribute).array as Float32Array;
    for (let i = 0; i < this.vertexCount; i++) {
      normals[i * 3] = 0;
      normals[i * 3 + 1] = 1;
      normals[i * 3 + 2] = 0;
    }

    // 4) Colores por vértice: pico → blanco, arritmia → rojo, resto → neutro.
    //    El último punto del head marca el estado del frente.
    const lastPoint = this.head.length > 0 ? this.head[this.head.length - 1] : null;
    const frontColor = lastPoint
      ? lastPoint.isPeak
        ? COLOR_PEAK
        : lastPoint.isArr
          ? COLOR_ARR
          : COLOR_NS
      : COLOR_NS;
    for (let i = 0; i < this.vertexCount; i++) {
      colors[i * 3] = frontColor.r;
      colors[i * 3 + 1] = frontColor.g;
      colors[i * 3 + 2] = frontColor.b;
    }

    pos.needsUpdate = true;
    col.needsUpdate = true;
    (this.geometry.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Actualiza la iluminación del material (pulso por latido). */
  setBeatPulse(intensity: number): void {
    this.beatPulse = Math.max(0, Math.min(1, intensity));
    this.material.emissiveIntensity = 0.35 + this.beatPulse * 1.2;
  }

  /** Actualización por frame (pulso decae). */
  update(deltaMs: number): void {
    this.beatPulse = Math.max(0, this.beatPulse - deltaMs / 600);
    this.material.emissiveIntensity = 0.35 + this.beatPulse * 1.2;
  }

  /** Elimina recursos WebGL asociados. */
  dispose(): void {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
