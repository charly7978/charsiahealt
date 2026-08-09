import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { EcgSceneManager } from '../EcgSceneManager';
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

const createMockRenderer = () => ({
  domElement: document.createElement('canvas'),
  setPixelRatio: vi.fn(),
  setClearColor: vi.fn(),
  setSize: vi.fn(),
  render: vi.fn(),
  dispose: vi.fn(),
});

type MockRenderer = ReturnType<typeof createMockRenderer>;

describe('EcgSceneManager', () => {
  let container: HTMLDivElement;
  let mockRenderer: MockRenderer;
  let manager: EcgSceneManager;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    mockRenderer = createMockRenderer();
    manager = new EcgSceneManager(container, {
      renderer: mockRenderer as unknown as THREE.WebGLRenderer,
      pixelRatioCap: 2,
    });
  });

  afterEach(() => {
    if (manager) manager.dispose();
    if (container.parentElement === document.body) document.body.removeChild(container);
  });

  it('crea renderer, escena y cámara', () => {
    expect(manager.renderer).toBe(mockRenderer as unknown as THREE.WebGLRenderer);
    expect(manager.scene).toBeInstanceOf(THREE.Scene);
    expect(manager.camera).toBeInstanceOf(THREE.PerspectiveCamera);
    expect(mockRenderer.setPixelRatio).toHaveBeenCalled();
    expect(mockRenderer.setClearColor).toHaveBeenCalled();
  });

  it('crea canales y los registra en la escena', () => {
    const mesh = manager.createChannel(CHANNEL);
    expect(mesh).toBeDefined();
    expect(manager.scene.children.includes(mesh.mesh)).toBe(true);
  });

  it('resize actualiza el renderer y la cámara', () => {
    manager.resize(800, 600);
    expect(mockRenderer.setSize).toHaveBeenCalledWith(800, 600, false);
    expect(manager.camera.aspect).toBeCloseTo(800 / 600, 5);
  });

  it('start/stop controlan el loop sin errores', () => {
    manager.start();
    manager.stop();
    manager.start();
    manager.stop();
    expect(mockRenderer.dispose).not.toHaveBeenCalled();
  });

  it('dispose doble no lanza errores', () => {
    manager.createChannel(CHANNEL);
    manager.dispose();
    expect(() => manager.dispose()).not.toThrow();
    expect(mockRenderer.dispose).toHaveBeenCalledTimes(1);
    expect(container.children.length).toBe(0);
  });
});
