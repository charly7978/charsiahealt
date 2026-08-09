# Implementation Plan

## [Overview]

Rediseñar por completo el monitor cardíaco de la app convirtiéndolo en un **monitor de doble canal hospitalario de gama alta** — canal ECG sintetizado (morfología fisiológica P-QRS-T) + canal PPG fiel del usuario — renderizados **en 3D WebGL con three.js** con perspectiva real, materiales pulidos, niebla y terminaciones finas profesionales, todo anclado 1:1 a la actividad cardíaca real del usuario.

La app ya captura la señal PPG real del dedo a ~30 Hz (cámara + flash, `PPGSignalProcessor`), detecta latidos con `AdvancedBeatDetector` (algoritmo WEPD, Han et al. 2022) que produce `bpm`, `confidence`, `isPeak`, `rrIntervals`, detección de AF/PVC/PAC, y métricas HRV (`sdnn`, `rmssd`, `pnn50`). El monitor actual (`PPGSignalMeter.tsx`, ~700 líneas) dibuja en Canvas 2D la señal PPG cruda con una proyección 3D manual básica.

El rediseño separa la visualización en dos escenarios 3D WebGL superpuestos verticalmente sobre una pantalla de monitor de cabecera:

1. **Canal ECG (superior, protagonista):** modelo paramétrico P-QRS-T (suma de gaussianas con fases/amplitudes fisiológicas: P, complejo QRS, segmento ST, onda T). Cada complejo se reconstruye en el instante exacto del latido real detectado, escalado temporalmente al intervalo RR real (taquicardia acorta, bradicardia estira) y con morfología alterada por ritmo (NSR, PVC con QRS ancho y sin onda P, PAC, FA con RR irregular, TACHY, BRADY). Es la representación fisiologicamente correcta del electrocardiograma que genera cada latido medido.
2. **Canal PPG (inferior, fiel):** el pulso fotopletismográfico real del usuario (pico sistólico, muesca dicrota, pico diastólico) renderizado como cinta 3D con brillo cálido (rojo/ámbar), sincronizado temporalmente con el canal ECG (el pico sistólico cae en la fase de eyección, ~después del complejo QRS).

La onda avanza en profundidad (eje Z) como una cinta 3D con iluminación por vértice (Three.js MeshStandardMaterial/MeshPhongMaterial), niebla lineal de profundidad, plano de rejilla en perspectiva, haz de barrido brillante y partículas de glóbulos rojos (Points) que fluyen por la cinta en el canal PPG. Cada latido real dispara un pulso de iluminación (intensidad del material + emisivo) y una marca de pico.

No se toca el pipeline de señal: `PPGSignalProcessor`, `AdvancedBeatDetector`, hooks y procesadores de vitales permanecen intactos. Solo se sustituye la capa de visualización de `PPGSignalMeter` y se añade el sintetizador de ECG + escenas WebGL.

La UI circundante se rediseña con estética de monitor de cabecera todopantalla: tipografía mono técnica (`Source Code Pro`), verde fósforo primario con acentos cian/ámbar/rojo, tarjetas de métricas con bordes finos de 1px, header con estado/calidad/timer, fila de métricas (HR, SpO₂, NIBP/MAP, Perfusión), banda de analítica (HRV, RR intervals, historial de latidos, tachograma) y footer con leyenda, velocidad de barrido y alarmas. Botones INICIAR/DETENER/RESET como controles flotantes con glow.

Rendimiento: WebGL dedicado (GPU) en lugar de CPU; solo se recrea geometría de la malla cuando ocurren eventos (latido, intervalo RR), el resto del frame se actualiza por desplazamiento de UVs/posiciones en el vertex shader. Límite de píxel ratio en móvil, backpressure ya existente del pipeline se respeta.

## [Types]

Se crean tipos nuevos (sintetizador ECG, escenas WebGL, datos de malla) sin romper los tipos existentes del pipeline (`ProcessedSignal`, `ContactState`, `VitalSignsResult`, etc.).

### 1. Modelo de ECG — `src/modules/ecg/types.ts`

```ts
/** Fases fisiológicas de un complejo P-QRS-T, como fracción del intervalo RR [0..1]. */
export const ECG_PHASE_DEFAULTS = {
  pStart: 0.020,     // inicio onda P
  pWidth: 0.100,     // duración onda P (~80–110 ms escalado)
  prSegment: 0.060,  // segmento PR isoeléctrico
  qrsStart: 0.180,   // inicio complejo QRS
  qrsWidth: 0.100,   // duración QRS (~80–120 ms escalado)
  stStart: 0.280,    // inicio segmento ST
  stWidth: 0.120,    // duración ST
  tStart: 0.400,     // inicio onda T
  tWidth: 0.160,     // duración T (~160 ms escalado)
  tpEnd: 1.0,        // fin de pausa TP (inicio siguiente ciclo)
} as const;

/** Amplitudes relativas a la onda R (R = 1). Config por ritmo. */
export interface ECGComplexConfig {
  pAmplitude: number;    // 0.15–0.25
  qAmplitude: number;    // -0.15…-0.25 (0 si ausente)
  rAmplitude: number;    // 1.0
  sAmplitude: number;    // -0.20…-0.40
  tAmplitude: number;    // 0.25–0.40
  qrsWidthRatio: number; // 1.0 NSR · 1.4 (QW) PVC · 0.8 PAC
  hasPWave: boolean;     // false en PVC
  stElevation: number;   // 0 normal · ±0.05 (elevación/depresión ST)
}

/** Ritmos soportados por el sintetizador. */
export type RhythmLabel = 'NSR' | 'PVC' | 'PAC' | 'AF' | 'TACHY' | 'BRADY';

/** Un complejo P-QRS-T concreto, escalado al RR real. */
export interface ECGComplex {
  rPeakTime: number;             // timestamp ms del pico R (latido real)
  durationMs: number;            // clamp(0.6 × RR, 420, 1050)
  rrMs: number;                  // intervalo RR real que lo genera
  rhythm: RhythmLabel;
  rScale: number;                // modulación respiratoria + jitter
  hasP: boolean;
  isWideQrs: boolean;
  samples: Array<{ t: number; y: number }>;  // 60 Hz
}

/** Lote emitido por el sintetizador. */
export interface ECGValuePoint {
  time: number;
  y: number;
  isPeak: boolean;
  rhythm: RhythmLabel;
  isArrhythmia: boolean;
}
```

### 2. Escenas WebGL — `src/render/ecg/types.ts`

```ts
export interface EcgSceneOptions {
  backgroundColor: number;       // 0x000a05
  fogNear: number;
  fogFar: number;
  pixelRatioCap: number;         // 2 píxel ratio móvil, 1.5 desktop
  antialias: boolean;
  powerPreference: 'high-performance';
}

export interface RibbonGeometryData {
  positions: Float32Array;       // x,y,z por vértice
  normals: Float32Array;
  uvs: Float32Array;             // u: posición en ventana, v: canal
  colors: Float32Array;          // por vértice (tinte por ritmo/arr)
  indices: Uint16Array;          // triángulos
  vertexCount: number;
}

export interface SweepBeamState {
  positionZ: number;             // avanza por la ventana
  intensity: number;             // pulso por latido
  lastPeakTime: number;
}

export interface EcgChannelConfig {
  /** Gama de alturas del canal en unidades de mundo. */
  baseY: number;
  amplitude: number;             // 1520 mundo para ECG, 1100 para PPG
  width: number;                 // 840 mundo
  depth: number;                 // 900 mundo
  timeWindowMs: number;          // 3200 ms
  depthSpanMs: number;           // 130 ms (profundidad perceptible)
  color: number;                 // ECG 0x00ff88 · PPG 0xff7050
  emissive: number;
  ribbonSegments: number;        // resolución longitudinal (≥ 220)
  ribbonSubSegments: number;     // resolución transversal (4)
}

export interface MonitorLayout {
  stage: { x0: number; y0: number; x1: number; y1: number }; // canvas overlay
  ecgViewport: { y0: number; y1: number };  // mitad superior
  ppgViewport: { y0: number; y1: number };  // mitad inferior
}
```

### 3. Estado del monitor (props)

Se mantiene `PPGSignalMeterProps` con nombres actuales (no rompe `Index.tsx`). Cambia el significado de `value`: pasa a ser la señal PPG normalizada que alimenta el **canal PPG**. Nuevos props opcionales:

```ts
interface NewOptionalProps {
  lastRR?: number;                 // último RR real (ms)
  sweepSpeed?: '25' | '50' | '100'; // mm/s (zoom temporal)
  hrvMetrics?: { sdnn: number; rmssd: number; pnn50: number };
}
```

## [Files]

### Dependencia nueva

`package.json`: añadir `"three": "^0.169.0"` y `"@types/three": "^0.169.0"` (dev). Sin otras dependencias. La escena WebGL se integra con un `<canvas>` propio gestionado por Three.js; la UI circundante se pinta en un `<canvas>` 2D overlay superpuesto.

### Archivos NUEVOS

| Ruta | Propósito |
|---|---|
| `src/modules/ecg/types.ts` | Tipos del modelo de ECG (fases, config, complex, salida). |
| `src/modules/ecg/ECGComplexModel.ts` | Modelo paramétrico P-QRS-T por suma de gaussianas. Genera `samples` de un complejo dado RR real + ritmo. |
| `src/modules/ecg/ECGWaveformSynthesizer.ts` | Sintetizador continuo: consume `isPeak`, `rrIntervals`, `arrhythmiaStatus`, `bpm` y emite el buffer `ECGValuePoint[]`. Gestiona jitter respiratorio, escalado por RR y variantes por ritmo. |
| `src/modules/ecg/__tests__/ECGWaveformSynthesizer.test.ts` | Pruebas unitarias del sintetizador y modelo. |
| `src/render/ecg/types.ts` | Tipos de escenas WebGL. |
| `src/render/ecg/EcgRibbonMesh.ts` | Construye y actualiza la malla Three.js de la cinta (BufferGeometry con positions/normals/uvs/colors/indices). Re-vertexing incremental al desplazar la ventana. |
| `src/render/ecg/EcgSceneManager.ts` | Gestiona el ciclo de vida de la escena Three.js: renderer, cámara, luces, niebla, fondo, resize/devicePixelRatio, loop rAF, dispose. Soporta 2 canales (ECG/Superior + PPG/Inferior). |
| `src/render/ecg/EcgParticles.ts` | Sistema de partículas de glóbulos (Points) que fluyen por la cinta PPG. |
| `src/render/ecg/__tests__/EcgSceneManager.test.ts` | Pruebas de ciclo de vida (create/dispose/resize sin fugas). |
| `src/render/ecg/__tests__/EcgRibbonMesh.test.ts` | Pruebas de geometría (vertexCount, bounds, índices válidos). |

### Archivos MODIFICADOS

| Ruta | Cambio |
|---|---|
| `src/components/PPGSignalMeter.tsx` | **REWRITE completo** (mismo nombre/archivo y props públicas). Estructura: (1) `<canvas>` WebGL Three.js a pantalla completa; (2) `<canvas>` 2D overlay para header/métricas/analítica/footer; (3) botones flotantes. Sustituye `draw3DStage`/`cardiacModel` por el sintetizador + `EcgSceneManager`. |
| `src/pages/Index.tsx` | Ajustes mínimos: pasar `lastRR`, `sweepSpeed` y opcional `hrvMetrics` al monitor. Sin cambios en lógica de captura. |
| `src/index.css` + `tailwind.config.ts` | Adiciones: keyframes `alarm-blink`, `monitor-scan`, utilidad `.text-glow`, ajuste de fuentes mono. Sin romper variables existentes. |

### No se tocan (pipeline intacto)

`PPGSignalProcessor.ts`, `AdvancedBeatDetector.ts`, `HeartBeatProcessor.ts`, hooks (`useSignalProcessor`, `useHeartBeatProcessor`, `useVitalSignsProcessor`), `VitalSignsProcessor`, `CameraView.tsx`, `VitalSign.tsx`.

## [Functions]

### `src/modules/ecg/ECGComplexModel.ts`

```ts
export function generateECGComplex(
  rrMs: number,
  config: ECGComplexConfig,
  options?: { sampleRateHz?: number; rScale?: number; seed?: number }
): { samples: Array<{ t: number; y: number }>; durationMs: number }

export function rhythmFromStatus(
  arrhythmiaStatus: string | undefined,
  bpm: number,
  rrIntervals: number[]
): RhythmLabel
```

- **generateECGComplex** — `durationMs = clamp(0.6 × rrMs, 420, 1050)`. Suma de gaussianas: `y(t) = Σ Aᵢ · exp(-(t-μᵢ)²/(2σᵢ²))` con μ/σ derivados de `ECG_PHASE_DEFAULTS × durationMs`. P (0.15–0.25), Q (-0.15), R (1.0), S (-0.30), T (0.30). PVC: `hasPWave=false`, `qrsWidthRatio=1.4` → QRS ancho y sin P. PAC: ratio 0.8 + P prematura. `rScale` modula amplitud total (respiración 0.12 + jitter). Muestreo 60 Hz. Error: si `rrMs ≤ 0` devuelve complejo NSR de 800 ms.
- **rhythmFromStatus** — parsea `arrhythmiaStatus` (formato `"ARRITMIA DETECTADA|N"`, contiene "AF"/"PVC"/"PAC"); brady < 60, tachy > 100; AF si RR irregular sostenido (CV > 0.12 en `rrIntervals`). Orden: PVC > AF > PAC > TACHY > BRADY > NSR.

### `src/modules/ecg/ECGWaveformSynthesizer.ts`

```ts
export class ECGWaveformSynthesizer {
  constructor(config: ECGWaveformSynthesizerConfig)
  /** Alimenta un latido real detectado. Devuelve el complejo generado. */
  onHeartBeat(peakTimeMs: number, rrMs: number, rhythm: RhythmLabel): ECGComplex | null
  /** Rellena el buffer continuo de puntos ECG hasta `untilTimeMs`. */
  sample(untilTimeMs: number): ECGValuePoint[]
  reset(): void
  getBufferedPoints(): ECGValuePoint[]
}
```

- Mantiene una cola de complejos activos (max 24, FIFO). En cada `sample`, itera desde el último tiempo muestreado hasta `untilTimeMs`, interpolando cada complejo activo (`samples`), avanzando la fase respiratoria y emitiendo `isPeak` en el instante del pico R.
- `onHeartBeat` ignora latidos a <250 ms del anterior (refractario) y reconstruye el complejo con el RR real.
- Rendimiento: la salida alimenta el `EcgRibbonMesh` (buffers preasignados); `sample` no asigna memoria en el hot path (reusa arrays).

### `src/render/ecg/EcgRibbonMesh.ts`

```ts
export class EcgRibbonMesh {
  constructor(scene: THREE.Scene, channel: EcgChannelConfig)
  /** Aplica un punto nuevo del buffer en la cabeza de la cinta. */
  pushPoint(point: { t: number; y: number; rhythm: RhythmLabel; isArr: boolean; isPeak: boolean }): void
  /** Desplaza la geometría: mueve vértices hacia -Z (persistencia) y libera colas. */
  advance(nowMs: number): void
  /** Actualiza iluminación/pulso del material (emissiveIntensity por latido). */
  setBeatPulse(intensity: number): void
  update(deltaMs: number): void
  dispose(): void
}
```

- Geometría: BufferGeometry con `positions`/`normals`/`uvs`/`colors`/`indices`. La cinta se define en X (ancho 840) × Y (amplitud) × Z (profundidad de ventana 900). Avance: cada vértice se desplaza en Z según `depthSpanMs/timeWindowMs`; al llegar al borde se recicla con el nuevo punto (ring buffer de vértices). Normales recalculadas incrementales para luz direccional estable.
- Material: `MeshPhongMaterial`/`MeshStandardMaterial` con `vertexColors`, `emissive` por canal (ECG verde, PPG rojo-ámbar), `emissiveIntensity` pulsante por latido, `side=DoubleSide`, `depthWrite=false` para la cinta transparente (glow).
- El color por vértice se tiñe de rojo `0xff3344` en tramos de arritmia y de blanco brillante en el pico R.

### `src/render/ecg/EcgSceneManager.ts`

```ts
export class EcgSceneManager {
  constructor(container: HTMLDivElement, options: EcgSceneOptions)
  createChannel(channel: EcgChannelConfig): EcgRibbonMesh
  addParticles(system: EcgParticles): void
  setSweep(positionZ: number, intensity: number): void
  resize(width: number, height: number): void
  start(): void                    // inicia el loop rAF
  stop(): void
  dispose(): void                  // libera geometry/materiales/renderer
}
```

- Crea `WebGLRenderer({ antialias, powerPreference: 'high-performance', alpha: false })`, `Scene` con `fog = new THREE.Fog(0x000a05, near, far)`. Cámara perspectiva con FOV ~45°, posición en Z ajustada a la profundidad.
- Luces: `DirectionalLight` (luz principal desde frente-arriba, intensidad pulsante por latido) + `AmbientLight` tenue + `PointLight` con color del canal → iluminación por vértice con brillo por latido. Rejilla: `GridHelper`/líneas propias en XZ con opacidad baja.
- Rejilla y plano base se dibujan en el mismo renderer (Background transparente en `index.css` para ver overlay UI). `resize` usa `window.devicePixelRatio` con cap en `pixelRatioCap`.
- Loop rAF: avanza cintas (`advance`), actualiza partículas, pulso de latido, haz de barrido (plano traslúcido en Z con `ShaderMaterial` custom: gradiente de intensidad + `beamPulse`), render. `dispose` libera todo (evita fugas de context WebGL).

### `src/render/ecg/EcgParticles.ts`

```ts
export class EcgParticles {
  constructor(scene: THREE.Scene, channel: EcgChannelConfig, count?: number)
  update(deltaMs: number, flowSpeed: number): void
  dispose(): void
}
```

- `THREE.Points` con `PointsMaterial({ size, vertexColors, transparent, opacity, blending: AdditiveBlending })`. Cada partícula tiene fase: `t0` (inicio), `tLife` (~1200 ms), y posición derivada de la curva de la cinta (sigue la forma PPG en Y). Avanza con `flowSpeed` (px/s según mm/s). Color rojo-anaranjado para glóbulos rojos; cian tenue para el canal ECG opcional.

### `src/components/PPGSignalMeter.tsx` (REWRITE)

Estructura del componente:

```tsx
const PPGSignalMeter = (props: PPGSignalMeterProps) => {
  const glContainerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<EcgSceneManager | null>(null);
  const ecgMeshRef = useRef<EcgRibbonMesh | null>(null);
  const ppgMeshRef = useRef<EcgRibbonMesh | null>(null);
  const synthRef = useRef<ECGWaveformSynthesizer | null>(null);
  const bgCacheRef = useRef<HTMLCanvasElement | null>(null);   // overlay estático (rejilla UI)
  // refs de props como hoy (propsRef)

  useEffect(() => { /* crear scene + canales + particles al montar; dispose al desmontar */ }, []);
  useEffect(() => { /* sincronizar props → synthRef / canales */ }, [props...]);
  useEffect(() => { /* loop rAF overlay 2D: header, métricas, analítica, footer */ }, []);

  const handleReset = useCallback(() => { /* reset synth, meshes, stats; onReset() */ }, [onReset]);

  return (
    <div className="fixed inset-0 bg-black">
      <div ref={glContainerRef} className="absolute inset-0" />        {/* WebGL */}
      <canvas ref={overlayRef} className="absolute inset-0 pointer-events-none" /> {/* overlay 2D */}
      <div className="fixed bottom-0 left-0 right-0 h-14 grid grid-cols-2 z-10">{/* botones */}</div>
    </div>
  );
};
```

- **Sincronización de latido:** `useEffect` observa `isPeak`; cuando pasa a `true` lee `bpm`/`rrIntervals`/`arrhythmiaStatus` → `rhythmFromStatus(...)`, construye el complejo con `generateECGComplex`, lo entrega a `synthRef.onHeartBeat(...)` y dispara `sceneRef.setBeatPulse(1.0)` + brote de partículas.
- **Canal PPG:** el `value` entrante (señal PPG real normalizada) se encola directamente en `ppgMeshRef.pushPoint({ y: value })`, con el pico sistólico brillando en rojo. La muesca dicrota y el pico diastólico aparecen de forma natural porque son la forma real del pulso.
- **Overlay 2D:** reutiliza los métodos de dibujo actuales (`drawHeader`, `drawMetricsRow`, `drawAnalyticsBand`, `drawFooter`) adaptados a un canvas 2D overlay (fondo de tarjetas traslúcido para no tapar el 3D). Header con estado/calidad/timer; métricas HR/SpO₂/NIBP/PI; analítica HRV/RR/beat-history/tachograma; footer con leyenda, velocidad y alarmas.

## [Changes]

El plan se ejecuta en fases con verificación en cada hito:

1. **Instalar three.js**: `bun add three` + `bun add -d @types/three`. Verificar `package.json`.
2. **Modelo de ECG puro** (`src/modules/ecg/`): implementar `types.ts`, `ECGComplexModel.ts` (gaussianas P-QRS-T), `ECGWaveformSynthesizer.ts`. Pruebas unitarias del sintetizador (complejo correcto para RR 600/1000 ms, PVC sin P + QRS ancho, jitter respiratorio, buffer FIFO). `vitest run` en verde.
3. **Escena WebGL base** (`src/render/ecg/`): `types.ts`, `EcgSceneManager` (renderer/cámara/luces/niebla/rejilla/resize/dispose), `EcgRibbonMesh` (geometría de cinta + avance + colores por vértice + pulso por latido). Pruebas de ciclo de vida y geometría.
4. **Canal ECG integrado**: conectar sintetizador → malla ECG (superior). Haz de barrido con `ShaderMaterial`, animación de cámara sutil (orbit lento ±2°), niebla.
5. **Canal PPG + partículas**: malla PPG (inferior) alimentada por `value` real; `EcgParticles` de glóbulos siguiendo la cinta.
6. **Rewrite del componente** (`PPGSignalMeter.tsx`): montar `EcgSceneManager` en container WebGL + overlay 2D; sincronizar `isPeak`/`rrIntervals`/`value`; botones rediseñados; integración del reset.
7. **UI: header/métricas/analítica/footer del overlay 2D** con estética de monitor de gama alta (ver [Types]/Estructura del componente).
8. **Integración en `Index.tsx`**: pasar `lastRR`, `sweepSpeed`; sin cambios de lógica.
9. **CSS/Tailwind**: keyframes `alarm-blink`, `monitor-scan`, `.text-glow`.
10. **Verificación final**: `bun run typecheck`, `bun run test`, `bun run build`, `bun run lint`. Arrancar dev server y revisar en navegador (web_fetch/browser_action) los 3 estados: reposo, monitoreo con señal estable, y simulación de latidos con PVC/FA para validar morfología del canal ECG y pulso visual.

Patrones técnicos clave:
- **Desplazamiento por ring buffer de vértices** (no realloc por frame) para la cinta: `advance()` mueve `positions` y recicla vértices al borde — 60fps estable en móvil.
- **Pulso por latido**: `emissiveIntensity` del material y `DirectionalLight.intensity` animados con `THREE.MathUtils.damp` (suave, sin saltos).
- **Colores por vértice** para arritmia/pico sin coste adicional de shaders.
- **Nitidez**: `pixelRatioCap = min(devicePixelRatio, 2)` móvil / `1.5` escritorio; `antialias: true`.
- **Dispose estricto** de geometrías/materiales/renderer para evitar fugas de context WebGL al desmontar.

## [Tests]

- Unit (`ECGWaveformSynthesizer.test.ts`): complejo P-QRS-T para RR 600/800/1000 ms — picos de fase correctos (P ~0.1×RR, QRS ~0.2×RR, T ~0.45×RR); PVC → sin onda P, QRS ancho (ratio 1.4), S profunda; PAC → QRS angosto; jitter respiratorio acota amplitud ±0.15; buffer FIFO con límite; reset limpio.
- Unit (`EcgRibbonMesh.test.ts`): vertexCount acorde a `ribbonSegments×ribbonSubSegments`; bounds X/Y/Z correctos; índices dentro de rango; avance desplaza Z y recicla sin fugas.
- Unit (`EcgSceneManager.test.ts`): create/dispose liberan geometry/materiales/renderer (sin error en dispose doble); resize actualiza cámara y renderer.
- Unit (`Ecg3DProjector` si se refactoriza — opcional): proyección conserva ratios en esquinas.
- Integration (`vitest` + `typecheck`): `bun run typecheck`, `bun run test`, `bun run build`.
- E2E manual (browser_action): reposo (sendero plano con rejilla); monitoreo con señal real (cinta ECG con complejos en cada latido + PPG con pulso real + partículas); PVC/FA simulado (complejo ancho sin P + tinte rojo + etiqueta RHYTHM).
- Performance: en dispositivo móvil objetivo, FPS ≥ 45 con `pixelRatioCap=2`; sin allocations por frame en el hot path (verificar con `performance.memory`/profiler).
- Datos de prueba: arrays de `rrIntervals` sintéticos (NSR regular, AF con CV>0.12, PVC aislado), `arrhythmiaStatus` en formato real `"ARRITMIA DETECTADA|N"`.

## [Criterios de aceptación]

1. La onda ECG muestra morfología P-QRS-T fisiológica en cada latido real (no es la señal PPG cruda camuflada).
2. El canal PPG muestra el pulso real del usuario con pico sistólico/muesca dicrota/pico diastólico.
3. Ambos canales están sincronizados al latido real detectado y avanzan en profundidad 3D con perspectiva e iluminación por latido.
4. PVC/PAC/AF cambian visiblemente la morfología ECG (QRS ancho sin P, tinte rojo, etiqueta de ritmo).
5. Rendimiento ≥ 45 FPS en móvil; el pipeline de detección de latidos no se modifica ni degrada.
6. `typecheck`, `test` y `build` pasan en verde.
