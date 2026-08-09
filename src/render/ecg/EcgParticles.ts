import * as THREE from 'three';
import type { EcgChannelConfig } from './types';

export class EcgParticles {
  private readonly scene: THREE.Scene;
  private readonly config: EcgChannelConfig;
  private readonly count: number;
  private points: THREE.Points | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.PointsMaterial | null = null;
  private readonly phases: Float32Array;

  constructor(scene: THREE.Scene, config: EcgChannelConfig, count = 180) {
    this.scene = scene;
    this.config = config;
    this.count = count;
    this.phases = new Float32Array(count);

    this.build();
  }

  private build(): void {
    const positions = new Float32Array(this.count * 3);
    const colors = new Float32Array(this.count * 3);

    for (let i = 0; i < this.count; i++) {
      this.phases[i] = Math.random();
      positions[i * 3] = (Math.random() - 0.5) * this.config.width;
      positions[i * 3 + 1] = this.config.baseY;
      positions[i * 3 + 2] = Math.random() * this.config.depth;

      colors[i * 3] = 1;
      colors[i * 3 + 1] = 0.35;
      colors[i * 3 + 2] = 0.2;
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    this.material = new THREE.PointsMaterial({
      size: 3.5,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.scene.add(this.points);
  }

  update(deltaMs: number, flowSpeed: number): void {
    if (!this.geometry || !this.points) return;
    const positions = this.geometry.attributes.position.array as Float32Array;

    for (let i = 0; i < this.count; i++) {
      this.phases[i] += (flowSpeed * deltaMs) / 1000;
      if (this.phases[i] > 1) this.phases[i] -= 1;

      const v = this.phases[i];
      positions[i * 3] = (v - 0.5) * this.config.width;
      positions[i * 3 + 1] = this.config.baseY + (Math.sin(v * Math.PI * 4) * 0.5) * this.config.amplitude;
      positions[i * 3 + 2] = this.config.depth - v * this.config.depth;
    }

    this.geometry.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    if (this.points) {
      this.scene.remove(this.points);
      this.points = null;
    }
  }
}