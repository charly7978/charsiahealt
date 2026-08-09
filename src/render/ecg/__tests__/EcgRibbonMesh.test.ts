import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { EcgRibbonMesh } from '../EcgRibbonMesh';

describe('EcgRibbonMesh', () => {
  let scene: THREE.Scene;

  beforeEach(() => {
    scene = new THREE.Scene();
  });

  it('creates mesh with expected vertex count', () => {
    const mesh = new EcgRibbonMesh(scene, {
      baseY: 0,
      amplitude: 100,
      width: 100,
      depth: 100,
      timeWindowMs: 1000,
      depthSpanMs: 100,
      color: 0x00ff88,
      emissive: 0x00ff88,
      ribbonSegments: 20,
      ribbonSubSegments: 4,
    });
    expect(mesh.getVertexCount()).toBeGreaterThan(0);
    mesh.dispose();
  });
});