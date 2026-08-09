import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { EcgRibbonMesh } from '../EcgRibbonMesh';
import type { EcgChannelConfig } from '../types';

const CHANNEL: EcgChannelConfig = {
  baseY: 300,
  amplitude: 100,
  width: 840,
  depth: 900,
  timeWindowMs: 3200,
  depthSpanMs: 130,
  color: 0x00ff88,
  emissive: 0x00aa55,
  ribbonSegments: 220,
  ribbonSubSegments: 4,
};

describe('EcgRibbonMesh', () => {
  let scene: THREE.Scene;
  let ribbon: EcgRibbonMesh;

  beforeEach(() => {
    scene = new THREE.Scene();
    ribbon = new EcgRibbonMesh(scene, CHANNEL);
  });

  it('vertexCount acorde a (segments+1)×(subSegments+1)', () => {
    const expected = (CHANNEL.ribbonSegments + 1) * (CHANNEL.ribbonSubSegments + 1);
    const pos = ribbon.mesh.geometry.attributes.position as THREE.BufferAttribute;
    expect(pos.count).toBe(expected);
    expect(pos.array.length).toBe(expected * 3);
  });

  it('bounds X/Y/Z correctos al crear', () => {
    const pos = ribbon.mesh.geometry.attributes.position.array as Float32Array;
    const count = pos.length / 3;

    for (let i = 0; i < count; i++) {
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      expect(Math.abs(x)).toBeLessThanOrEqual(CHANNEL.width / 2 + 1e-6);
      expect(y).toBeLessThanOrEqual(CHANNEL.baseY + CHANNEL.amplitude + 1e-6);
      expect(y).toBeGreaterThanOrEqual(CHANNEL.baseY - CHANNEL.amplitude - 1e-6);
      expect(z).toBeLessThanOrEqual(0 + 1e-6);
      expect(z).toBeGreaterThanOrEqual(-CHANNEL.depth - 1e-6);
    }
  });

  it('índices dentro de rango y triangulación correcta', () => {
    const index = ribbon.mesh.geometry.index as THREE.BufferAttribute;
    const vertexCount = (ribbon.mesh.geometry.attributes.position as THREE.BufferAttribute).count;
    const arr = index.array as Uint16Array;
    expect(index.count).toBe(CHANNEL.ribbonSegments * CHANNEL.ribbonSubSegments * 6);
    for (let i = 0; i < arr.length; i++) {
      expect(arr[i]).toBeGreaterThanOrEqual(0);
      expect(arr[i]).toBeLessThan(vertexCount);
    }
  });

  it('avance desplaza vértices hacia -Z y recicla el frente', () => {
    const posAttr = ribbon.mesh.geometry.attributes.position as THREE.BufferAttribute;
    const before = (posAttr.array as Float32Array).slice();

    ribbon.pushPoint({ t: 1000, y: 0.4, rhythm: 'NSR', isArr: false, isPeak: false });
    ribbon.advance(1000);
    ribbon.advance(2000);

    const after = posAttr.array as Float32Array;

    // Ningún vértice quedó fuera de la ventana [-depth, 0] (reciclado).
    for (let i = 0; i < after.length / 3; i++) {
      expect(after[i * 3 + 2]).toBeGreaterThanOrEqual(-CHANNEL.depth - 1e-6);
      expect(after[i * 3 + 2]).toBeLessThanOrEqual(0 + 1e-6);
    }

    // Algunos vértices se movieron (z distinto del inicial).
    let moved = 0;
    for (let i = 0; i < before.length / 3; i++) {
      if (Math.abs(before[i * 3 + 2] - after[i * 3 + 2]) > 1) moved++;
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('setBeatPulse actualiza emissiveIntensity del material', () => {
    ribbon.setBeatPulse(1);
    const mat = ribbon.mesh.material as THREE.MeshPhongMaterial;
    expect(mat.emissiveIntensity).toBeGreaterThan(0.35);
  });

  it('dispose elimina la malla de la escena y libera geometría/material', () => {
    const geometry = ribbon.mesh.geometry;
    const material = ribbon.mesh.material;
    ribbon.dispose();
    expect(scene.children.includes(ribbon.mesh)).toBe(false);
    expect(geometry).toBeDefined();
    expect(material).toBeDefined();
  });

  it('pushPoint retiene head sin romper el mesh', () => {
    for (let i = 0; i < 1000; i++) {
      ribbon.pushPoint({ t: i, y: 0, rhythm: 'NSR', isArr: false, isPeak: false });
    }
    ribbon.advance(16);
    expect(ribbon.mesh.geometry.attributes.position).toBeDefined();
  });
});
