import { describe, it, expect, vi } from 'vitest';

vi.mock('three', () => {
  const makeVector3 = () => ({ set: () => {} });
  const makeColor = () => ({ set: () => {} });

  return {
    WebGLRenderer: class MockRenderer {
      domElement = document.createElement('canvas');
      setSize = () => {};
      setPixelRatio = () => {};
      setClearColor = () => {};
      render = () => {};
      dispose = () => {};
    },
    Scene: class MockScene {
      fog = null;
      add = () => {};
      clear = () => {};
    },
    PerspectiveCamera: class MockCamera {
      aspect = 1;
      updateProjectionMatrix = () => {};
      position = { set: () => {} };
      lookAt = () => {};
    },
    DirectionalLight: class MockLight { position = makeVector3(); },
    AmbientLight: class MockAmbientLight {},
    PointLight: class MockPointLight { position = makeVector3(); },
    GridHelper: class MockGridHelper { position = makeVector3(); },
    PlaneGeometry: class MockPlaneGeometry {},
    MeshBasicMaterial: class MockBasicMaterial {},
    Fog: class MockFog {},
    BufferGeometry: class MockBufferGeometry {
      setAttribute = () => {};
      setIndex = () => {};
      computeVertexNormals = () => {};
      attributes = { position: { needsUpdate: false } };
      dispose = () => {};
    },
    BufferAttribute: class MockBufferAttribute {},
    MeshStandardMaterial: class MockMaterial {},
    Mesh: class MockMesh { position = makeVector3(); },
    Points: class MockPoints {
      geometry = { dispose: () => {} };
      material = { dispose: () => {} };
    },
    PointsMaterial: class MockPointsMaterial {},
    Color: makeColor(),
    MathUtils: { damp: () => {} },
    Clock: class MockClock {
      getDelta = () => 0;
    },
    DoubleSide: 2,
    AdditiveBlending: 2,
  };
});

import { EcgSceneManager } from '../EcgSceneManager';

describe('EcgSceneManager', () => {
  it('crea y dispose sin lanzar con mock de Three.js', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const manager = new EcgSceneManager(container, {
      backgroundColor: 0x000a05,
      fogNear: 800,
      fogFar: 3200,
      pixelRatioCap: 2,
      antialias: true,
      powerPreference: 'high-performance',
    }, {
      stage: { x0: 0, y0: 0, x1: 100, y1: 100 },
      ecgViewport: { y0: 0, y1: 50 },
      ppgViewport: { y0: 50, y1: 100 },
    });
    expect(manager).toBeTruthy();
    manager.dispose();
    expect(container.children.length).toBe(0);
    document.body.removeChild(container);
  });
});