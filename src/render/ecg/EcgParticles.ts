import * as THREE from 'three';
import type { EcgChannelConfig } from './types';

interface Particle {
  /** Fase normalizada [0..1]: dónde está la partícula en el canal. */
  phase: number;
  /** Vida restante en ms. */
  lifeMs: number;
  /** Velocidad propia (px/s equivalente en mundo). */
  speed: number;
}

/**
 * Sistema de partículas de glóbulos (Points) que fluyen por la cinta PPG
 * siguiendo su forma en Y. Avanza con `flowSpeed` (mm/s del barrido).
 */
export class EcgParticles {
  readonly points: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;
  private readonly channel: EcgChannelConfig;
  private readonly count: number;

  /** Estado por partícula. */
  private readonly particleData: Particle[];
  private readonly ages: Float32Array;

  private readonly posAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;

  private readonly baseColor = new THREE.Color(0xff7050);
  private readonly peakColor = new THREE.Color(0xffd9a0);

  /** Brote de partículas al frente (0..1), decae en update(). */
  private burstStrength = 0;

  constructor(scene: THREE.Scene, channel: EcgChannelConfig, count = 140) {
    this.channel = channel;
    this.count = count;

    this.geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    this.ages = new Float32Array(count);

    this.particleData = [];
    for (let i = 0; i < count; i++) {
      this.particleData.push({
        phase: Math.random(),
        lifeMs: 600 + Math.random() * 900,
        speed: 0.6 + Math.random() * 0.8,
      });
      this.ages[i] = Math.random();
      positions[i * 3 + 1] = channel.baseY;
    }

    this.posAttr = new THREE.BufferAttribute(positions, 3);
    this.colorAttr = new THREE.BufferAttribute(colors, 3);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colorAttr);

    this.material = new THREE.PointsMaterial({
      size: 7,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  /** Dispara un brote de partículas al frente (pulso por latido). */
  burst(): void {
    this.burstStrength = 1;
    // Reavivar partículas cercanas al frente.
    for (let i = 0; i < this.count; i += 3) {
      const p = this.particleData[i];
      p.phase = Math.min(1, 0.82 + Math.random() * 0.14);
      p.lifeMs = 500 + Math.random() * 500;
    }
  }

  /** Actualiza posiciones (fase avanza y vida decae). */
  update(deltaMs: number, flowSpeed: number): void {
    this.burstStrength = Math.max(0, this.burstStrength - deltaMs / 500);

    const { baseY, amplitude, width, depth } = this.channel;
    const halfW = width / 2;
    const positions = this.posAttr.array as Float32Array;
    const colors = this.colorAttr.array as Float32Array;

    for (let i = 0; i < this.count; i++) {
      const p = this.particleData[i];

      // Avanzar fase a lo largo del eje Z (profundidad → frente).
      const dzPerMs = (depth * flowSpeed) / 1000;
      p.phase += (p.speed * dzPerMs * deltaMs) / depth;

      // Ciclo de vida: al terminar, respawn en el fondo.
      p.lifeMs -= deltaMs;
      if (p.lifeMs <= 0) {
        p.lifeMs = 600 + Math.random() * 900;
        p.phase = 0.95 + Math.random() * 0.05; // reaparecen al fondo
        p.speed = 0.6 + Math.random() * 0.8;
      }

      // Posición: X fijo (ligero jitter), Z = -depth + phase*depth, Y según
      // una onda PPG simplificada (pico sistólico cerca del frente).
      const frac = Math.min(1, Math.max(0, p.phase));
      const jitterX = Math.sin(i * 1.7) * 8;
      const x = -halfW * 0.7 + jitterX;
      const z = -depth * (1 - frac);
      // Forma PPG: subida rápida y caída lenta (dicrotismo suave).
      const t = 1 - frac; // 0 fondo .. 1 frente
      const ppgY = Math.sin(Math.min(1, t * 2.4) * Math.PI * 0.5) * amplitude * 0.85;
      const y = baseY + ppgY;

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      // Color: rojo cálido; cerca del pico → crema.
      const nearPeak = t > 0.72 ? 1 : 0;
      colors[i * 3] = this.baseColor.r + (this.peakColor.r - this.baseColor.r) * nearPeak;
      colors[i * 3 + 1] = this.baseColor.g + (this.peakColor.g - this.baseColor.g) * nearPeak;
      colors[i * 3 + 2] = this.baseColor.b + (this.peakColor.b - this.baseColor.b) * nearPeak;
    }

    this.posAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  /** Libera los recursos WebGL. */
  dispose(): void {
    if (this.points.parent) this.points.parent.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}
