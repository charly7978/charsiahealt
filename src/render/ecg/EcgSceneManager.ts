import * as THREE from 'three';
import type { EcgSceneOptions, EcgChannelConfig } from './types';
import { EcgRibbonMesh } from './EcgRibbonMesh';

/** Referencia perezosa a EcgParticles para evitar dependencia circular. */
type ParticlesRef = { update(deltaMs: number, flowSpeed: number): void; dispose(): void };

/** Config por defecto de la escena. */
const DEFAULT_OPTIONS: EcgSceneOptions = {
  backgroundColor: 0x000a05,
  fogNear: 700,
  fogFar: 1700,
  pixelRatioCap: 2,
  antialias: true,
  powerPreference: 'high-performance',
};

/**
 * Gestor de la escena WebGL three.js del monitor.
 *
 * Crea renderer, cámara perspectiva, luces (direccional pulsante por latido
 * + ambiente), niebla lineal, plano de rejilla en XZ y el haz de barrido
 * (plano traslúcido con ShaderMaterial). Gestiona el loop rAF, resize con
 * cap de pixel ratio y dispose estricto (sin fugas de contexto WebGL).
 */
export class EcgSceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private readonly container: HTMLDivElement;
  private readonly options: EcgSceneOptions;

  private readonly channels: EcgRibbonMesh[] = [];
  private readonly particleSystems: ParticlesRef[] = [];

  private readonly dirLight: THREE.DirectionalLight;

  private beam: THREE.Mesh | null = null;
  private beamUniforms: { uProgress: { value: number }; uIntensity: { value: number } } | null = null;

  private rafId = 0;
  private running = false;
  private lastFrameTime = 0;
  private disposed = false;

  /** Pulso de luz por latido (0..1), animado con damp en el loop. */
  private beatPulse = 0;
  /** Posición del haz de barrido (0..1). */
  private beamProgress = 0;

  constructor(container: HTMLDivElement, options?: Partial<EcgSceneOptions>) {
    this.container = container;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // --- Renderer ---
    if (this.options.renderer) {
      this.renderer = this.options.renderer;
    } else {
      this.renderer = new THREE.WebGLRenderer({
        antialias: this.options.antialias,
        alpha: false,
        powerPreference: this.options.powerPreference,
      });
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.options.pixelRatioCap));
    this.renderer.setClearColor(this.options.backgroundColor, 1);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.container.appendChild(this.renderer.domElement);

    // --- Escena + niebla ---
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.options.backgroundColor);
    this.scene.fog = new THREE.Fog(this.options.backgroundColor, this.options.fogNear, this.options.fogFar);

    // --- Cámara ---
    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 4000);
    this.camera.position.set(0, 240, 1050);
    this.camera.lookAt(0, 0, -300);

    // --- Luces ---
    this.dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
    this.dirLight.position.set(300, 900, 700);
    this.scene.add(this.dirLight);

    const ambient = new THREE.AmbientLight(0x223322, 0.45);
    this.scene.add(ambient);

    this.buildGrid();
    this.buildBeam();

    // Resize inicial.
    const rect = container.getBoundingClientRect();
    this.resize(
      rect.width || container.clientWidth || 1,
      rect.height || container.clientHeight || 1
    );
  }

  /** Crea un canal (cinta) y la registra en la escena. */
  createChannel(channel: EcgChannelConfig): EcgRibbonMesh {
    const mesh = new EcgRibbonMesh(this.scene, channel);
    this.channels.push(mesh);
    return mesh;
  }

  /** Añade un sistema de partículas a la escena. */
  addParticles(system: ParticlesRef): void {
    this.particleSystems.push(system);
  }

  /** Avanza el haz de barrido y su intensidad por latido. */
  setSweep(positionZ: number, intensity: number): void {
    this.beamProgress = Math.max(0, Math.min(1, positionZ));
    this.beatPulse = Math.max(this.beatPulse, Math.max(0, Math.min(1, intensity)));
  }

  /** Actualiza el tamaño del renderer y la relación de aspecto de la cámara. */
  resize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Inicia el loop rAF. */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  /** Detiene el loop rAF. */
  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /** Libera renderer, geometrías, materiales y detecta un eventual doble dispose. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();

    for (const channel of this.channels) channel.dispose();
    for (const particles of this.particleSystems) particles.dispose();

    if (this.beam) {
      this.scene.remove(this.beam);
      this.beam.geometry.dispose();
      const mat = this.beam.material as THREE.ShaderMaterial;
      if (mat) mat.dispose();
      this.beam = null;
    }

    // Dispose de cualquier material/geometría restante en la escena.
    const disposedGeometries = new Set<THREE.BufferGeometry>();
    const disposedMaterials = new Set<THREE.Material>();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry && !disposedGeometries.has(mesh.geometry)) {
        mesh.geometry.dispose();
        disposedGeometries.add(mesh.geometry);
      }
      const mat = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (mat) {
        const mats = Array.isArray(mat) ? mat : [mat];
        for (const m of mats) {
          if (m && !disposedMaterials.has(m)) {
            m.dispose();
            disposedMaterials.add(m);
          }
        }
      }
    });

    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
    this.renderer.dispose();
  }

  /** Loop principal. */
  private readonly loop = (now: number) => {
    if (!this.running || this.disposed) return;
    const dt = Math.max(0, now - this.lastFrameTime);
    this.lastFrameTime = now;

    // ~60fps; por debajo de 30fps el dt se acota para no "saltar" la cinta.
    const dtClamped = Math.min(dt, 64);

    for (const channel of this.channels) {
      channel.advance(now);
      channel.update(dtClamped);
    }
    for (const system of this.particleSystems) {
      system.update(dtClamped, 1);
    }

    // Pulso de luz suave (damp) por latido.
    this.beatPulse = THREE.MathUtils.damp(this.beatPulse, 0, 6, dtClamped / 1000);
    this.dirLight.intensity = 0.85 + this.beatPulse * 0.9;

    // Haz de barrido: avanza y pulsea.
    if (this.beamUniforms && this.beam) {
      this.beamUniforms.uProgress.value = this.beamProgress;
      this.beamUniforms.uIntensity.value = 0.25 + this.beatPulse * 0.6;

      this.beamProgress += dtClamped / 2800; // ~2.8s por barrido
      if (this.beamProgress > 1) this.beamProgress = 0;
    }

    this.renderer.render(this.scene, this.camera);
    this.rafId = requestAnimationFrame(this.loop);
  };

  /** Construye la rejilla en el plano XZ (fondo del monitor). */
  private buildGrid(): void {
    const grid = new THREE.GridHelper(1900, 24, 0x00ff88, 0x00aa55);
    const mat = grid.material as THREE.Material;
    mat.transparent = true;
    mat.opacity = 0.07;
    mat.depthWrite = false;
    grid.position.set(0, -560, -760);
    this.scene.add(grid);
  }

  /** Construye el haz de barrido (plano traslúcido con ShaderMaterial). */
  private buildBeam(): void {
    const geo = new THREE.PlaneGeometry(2000, 1600);
    const uniforms = {
      uProgress: { value: 0 },
      uIntensity: { value: 0.3 },
      uColor: { value: new THREE.Color(0x00ff88) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uProgress;
        uniform float uIntensity;
        uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          float dist = abs(vUv.x - uProgress);
          float glow = exp(-dist * 26.0) * uIntensity;
          float edge = smoothstep(0.02, 0.0, dist) * uIntensity * 0.35;
          gl_FragColor = vec4(uColor * (glow + edge), glow + edge);
        }
      `,
    });
    this.beam = new THREE.Mesh(geo, mat);
    this.beam.position.set(0, 0, 0);
    this.beam.rotation.y = -Math.PI / 2; // plano perpendicular a X (barrido vertical)
    this.beamUniforms = uniforms;
    this.scene.add(this.beam);
  }
}
