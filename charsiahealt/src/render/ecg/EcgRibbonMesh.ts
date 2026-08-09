import * as THREE from 'three';
import type { EcgChannelConfig, RibbonGeometryData } from './types';

export class EcgRibbonMesh {
  private readonly scene: THREE.Scene;
  private readonly config: EcgChannelConfig;
  private readonly ribbonSegments: number;
  private readonly ribbonSubSegments: number;

  private mesh: THREE.Mesh | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.MeshStandardMaterial | null = null;
  private readonly vertexCount: number;

  private writeIndex = 0;
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly uvs: Float32Array;
  private readonly colors: Float32Array;

  constructor(scene: THREE.Scene, config: EcgChannelConfig) {
    this.scene = scene;
    this.config = config;
    this.ribbonSegments = Math.max(config.ribbonSegments, 220);
    this.ribbonSubSegments = Math.max(config.ribbonSubSegments, 4);

    const rows = this.ribbonSegments + 1;
    const cols = this.ribbonSubSegments + 1;
    this.vertexCount = rows * cols;

    this.positions = new Float32Array(this.vertexCount * 3);
    this.normals = new Float32Array(this.vertexCount * 3);
    this.uvs = new Float32Array(this.vertexCount * 2);
    this.colors = new Float32Array(this.vertexCount * 3);

    this.buildGeometry();
    this.buildMaterial();
    this.buildMesh();
  }

  private buildGeometry(): void {
    const rows = this.ribbonSegments + 1;
    const cols = this.ribbonSubSegments + 1;
    const indices: number[] = [];

    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const idx = i * cols + j;
        const u = j / this.ribbonSubSegments;
        const v = i / this.ribbonSegments;

        this.uvs[idx * 2] = u;
        this.uvs[idx * 2 + 1] = v;

        const x = (u - 0.5) * this.config.width;
        const y = this.config.baseY;
        const z = this.config.depth - v * this.config.depth;
        this.positions[idx * 3] = x;
        this.positions[idx * 3 + 1] = y;
        this.positions[idx * 3 + 2] = z;

        this.normals[idx * 3] = 0;
        this.normals[idx * 3 + 1] = 1;
        this.normals[idx * 3 + 2] = 0;

        this.colors[idx * 3] = ((this.config.color >> 16) & 0xff) / 255;
        this.colors[idx * 3 + 1] = ((this.config.color >> 8) & 0xff) / 255;
        this.colors[idx * 3 + 2] = (this.config.color & 0xff) / 255;
      }
    }

    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = i * cols + j;
        const b = i * cols + j + 1;
        const c = (i + 1) * cols + j;
        const d = (i + 1) * cols + j + 1;
        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setIndex(indices);
    this.geometry.computeVertexNormals();
  }

  private buildMaterial(): void {
    this.material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.config.color),
      emissive: new THREE.Color(this.config.emissive),
      emissiveIntensity: 0.4,
      metalness: 0.15,
      roughness: 0.35,
      side: THREE.DoubleSide,
      vertexColors: true,
      depthWrite: false,
      transparent: true,
      opacity: 0.92,
    });
  }

  private buildMesh(): void {
    if (!this.geometry || !this.material) return;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  pushPoint(point: { t: number; y: number; rhythm: string; isArr: boolean; isPeak: boolean }): void {
    if (!this.geometry || !this.mesh) return;

    const rows = this.ribbonSegments + 1;
    const cols = this.ribbonSubSegments + 1;
    const row = this.writeIndex % rows;
    const colBase = (this.writeIndex / rows) | 0;
    const col = colBase % cols;

    const idx = row * cols + col;
    if (idx >= this.vertexCount) return;

    const normalizedY = (this.config.amplitude - point.y * this.config.amplitude) / this.config.amplitude - 0.5;
    const worldY = this.config.baseY + normalizedY * this.config.amplitude;
    const z = this.config.depth - (row / this.ribbonSegments) * this.config.depth;

    this.positions[idx * 3] = point.t * this.config.width - this.config.width / 2;
    this.positions[idx * 3 + 1] = worldY;
    this.positions[idx * 3 + 2] = z;

    const color = new THREE.Color(this.config.color);
    if (point.isArr) {
      color.set('#ff3344');
    } else if (point.isPeak) {
      color.set('#ffffff');
    }

    this.colors[idx * 3] = color.r;
    this.colors[idx * 3 + 1] = color.g;
    this.colors[idx * 3 + 2] = color.b;

    this.writeIndex = (this.writeIndex + 1) % this.vertexCount;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  advance(nowMs: number): void {
    if (!this.geometry) return;
    const rows = this.ribbonSegments + 1;
    const cols = this.ribbonSubSegments + 1;

    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const idx = i * cols + j;
        const z = this.positions[idx * 3 + 2];
        const speed = (this.config.depth / this.config.timeWindowMs) * 16;
        const newZ = z - speed;
        if (newZ < 0) {
          this.positions[idx * 3 + 2] = this.config.depth;
        } else {
          this.positions[idx * 3 + 2] = newZ;
        }
      }
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  setBeatPulse(intensity: number): void {
    if (!this.material) return;
    this.material.emissiveIntensity = 0.4 + clamp(intensity, 0, 1) * 0.8;
  }

  update(deltaMs: number): void {
    this.advance(Date.now());
  }

  getVertexCount(): number {
    return this.vertexCount;
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
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh = null;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}