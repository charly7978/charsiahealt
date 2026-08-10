import * as THREE from 'three';
import type { EcgSceneOptions, EcgChannelConfig, MonitorLayout, SweepBeamState } from './types';
import { EcgRibbonMesh } from './EcgRibbonMesh';

export class EcgSceneManager {
  private readonly container: HTMLDivElement;
  private readonly options: EcgSceneOptions;
  private readonly layout: MonitorLayout;

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private animationId: number | null = null;
  private disposed = false;

  private ecgMesh: EcgRibbonMesh | null = null;
  private ppgMesh: EcgRibbonMesh | null = null;
  private particles: THREE.Points | null = null;
  private grid: THREE.GridHelper | null = null;
  private sweepBeamMesh: THREE.Mesh | null = null;
  private lights: THREE.Light[] = [];

  private readonly sweepBeam: SweepBeamState = {
    positionZ: 0,
    intensity: 0,
    lastPeakTime: 0,
  };

  private readonly clock = new THREE.Clock();
  private beatPulse = 0;

  constructor(container: HTMLDivElement, options: EcgSceneOptions, layout: MonitorLayout) {
    this.container = container;
    this.options = options;
    this.layout = layout;
    this.init();
  }

  private init(): void {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({
      antialias: this.options.antialias,
      powerPreference: this.options.powerPreference,
      alpha: false,
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.options.pixelRatioCap));
    this.renderer.setClearColor(this.options.backgroundColor);
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(this.options.backgroundColor, this.options.fogNear, this.options.fogFar);

    this.camera = new THREE.PerspectiveCamera(45, width / Math.max(height, 1), 10, 5000);
    this.camera.position.set(0, -180, 1400);
    this.camera.lookAt(0, 0, 0);

    const ambient = new THREE.AmbientLight('#445566', 0.6);
    this.scene.add(ambient);
    this.lights.push(ambient);

    const directional = new THREE.DirectionalLight('#ffffff', 0.9);
    directional.position.set(200, -300, 900);
    this.scene.add(directional);
    this.lights.push(directional);

    const point = new THREE.PointLight('#00ff88', 0.7, 1600);
    point.position.set(0, -120, 700);
    this.scene.add(point);
    this.lights.push(point);

    this.addGrid();
    this.addSweepBeam();

    window.addEventListener('resize', this.onResize);
  }

  private addGrid(): void {
    if (!this.scene) return;
    this.grid = new THREE.GridHelper(1800, 36, '#1a3a2a', '#0d1f16');
    this.grid.position.y = 400;
    this.grid.position.z = -300;
    this.scene.add(this.grid);
  }

  private addSweepBeam(): void {
    if (!this.scene) return;
    const geometry = new THREE.PlaneGeometry(80, 1600);
    const material = new THREE.MeshBasicMaterial({
      color: '#00ff88',
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.sweepBeamMesh = new THREE.Mesh(geometry, material);
    this.sweepBeamMesh.position.set(0, 0, 0);
    this.scene.add(this.sweepBeamMesh);
  }

  getScene(): THREE.Scene {
    if (!this.scene) throw new Error('Scene not initialized');
    return this.scene;
  }

  createChannel(config: EcgChannelConfig): EcgRibbonMesh {
    if (!this.scene) throw new Error('Scene not initialized');
    const mesh = new EcgRibbonMesh(this.scene, config);
    if (config.color === 0x00ff88) {
      this.ecgMesh = mesh;
    } else {
      this.ppgMesh = mesh;
    }
    return mesh;
  }

  addParticles(particles: THREE.Points): void {
    if (!this.scene) return;
    this.particles = particles;
    this.scene.add(particles);
  }

  setSweep(positionZ: number, intensity: number): void {
    this.sweepBeam.positionZ = positionZ;
    this.sweepBeam.intensity = intensity;
    this.sweepBeam.lastPeakTime = Date.now();
  }

  triggerBeatPulse(intensity = 1): void {
    this.beatPulse = clamp(intensity, 0, 1);
  }

  private onResize = (): void => {
    if (!this.renderer || !this.camera || !this.container) return;
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  };

  start(): void {
    if (this.disposed || !this.renderer || !this.scene || !this.camera) return;
    const animate = () => {
      if (this.disposed) return;
      this.animationId = requestAnimationFrame(animate);

      const delta = this.clock.getDelta();
      const now = Date.now();

      if (this.ecgMesh) this.ecgMesh.update(delta);
      if (this.ppgMesh) this.ppgMesh.update(delta);

      if (this.particles) {
        this.particles.rotation.y += delta * 0.05;
      }

      if (this.beatPulse > 0.01) {
        if (this.ecgMesh) this.ecgMesh.setBeatPulse(this.beatPulse);
        if (this.ppgMesh) this.ppgMesh.setBeatPulse(this.beatPulse);
        this.beatPulse *= 0.92;
      } else {
        this.beatPulse = 0;
        if (this.ecgMesh) this.ecgMesh.setBeatPulse(0);
        if (this.ppgMesh) this.ppgMesh.setBeatPulse(0);
      }

      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  stop(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();

    window.removeEventListener('resize', this.onResize);

    if (this.ecgMesh) {
      this.ecgMesh.dispose();
      this.ecgMesh = null;
    }
    if (this.ppgMesh) {
      this.ppgMesh.dispose();
      this.ppgMesh = null;
    }
    if (this.particles) {
      this.particles.geometry.dispose();
      if (Array.isArray(this.particles.material)) {
        this.particles.material.forEach((m) => m.dispose());
      } else {
        this.particles.material.dispose();
      }
      this.particles = null;
    }
    if (this.grid) {
      this.grid.geometry.dispose();
      if (Array.isArray(this.grid.material)) {
        this.grid.material.forEach(m => m.dispose());
      } else {
        this.grid.material.dispose();
      }
      this.grid = null;
    }
    if (this.sweepBeamMesh) {
      this.sweepBeamMesh.geometry.dispose();
      if (Array.isArray(this.sweepBeamMesh.material)) {
        this.sweepBeamMesh.material.forEach(m => m.dispose());
      } else {
        this.sweepBeamMesh.material.dispose();
      }
      this.sweepBeamMesh = null;
    }
    this.lights.forEach(light => {
      if (light instanceof THREE.Light) {
        this.scene?.remove(light);
      }
    });
    this.lights = [];

    if (this.scene) {
      this.scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          if (Array.isArray(object.material)) {
            object.material.forEach(m => m.dispose());
          } else {
            object.material.dispose();
          }
        }
      });
      this.scene.clear();
      this.scene = null;
    }
    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
      this.renderer = null;
    }
    this.camera = null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}