# Auditoría de Depuración del Repositorio

**Fecha:** 2026-05-09 (actualizado 2026-08-07)
**Objetivo:** repositorio sin archivos huérfanos, código duplicado ni APIs obsoletas.

## Archivos eliminados

| Archivo | Motivo |
|---|---|
| `src/components/CameraPreview.tsx` | Componente obsoleto, reemplazado por `CameraView.tsx`. Cero importadores. |
| `src/components/MonitorButton.tsx` | Botón legacy no usado en ningún lado. |
| `src/utils/qualityUtils.ts` | Utilidad sin importadores; lógica de calidad vive en `PPGSignalProcessor`. |
| API `setArrhythmiaState` (no-op) en `useHeartBeatProcessor` | Era función vacía; las arritmias se gestionan en `ArrhythmiaProcessor`. Eliminadas también las 3 llamadas en `Index.tsx`. |
| `src/App.css` | Huérfano (solo se importa `index.css`). |
| `src/components/ui/use-toast.ts` | Shim duplicado; todos los imports apuntan a `@/hooks/use-toast`. |
| `src/components/ui/toaster.tsx` | Portal Radix nunca montado (revertido en 2026-08-07: los `toast()` siguen despachando al store sin UI, comportamiento original). |
| Exports muertos: `playAlertBeep`, `setLogLevel`/`getLogLevel`, `getPpgRuntimeDefaults`, `resetBackpressureConfig`, global `Window.heartBeatProcessor`, `FrameSample` | Cero importadores verificados. |

## Consolidaciones

| Cambio | Motivo |
|---|---|
| **Pipeline Web Worker eliminado por completo** (`src/lib/ppg/**`) | Duplicaba ROI, detección de dedo, fusión de canales (PCA — inferior a POS según benchmark), SQI y buffers; solo alimentaba el panel de diagnóstico (desactivado). Se conserva `biquadFilter.ts` como única implementación de filtro. Eliminado también su UI en Index.tsx (panel "Advanced engine" + sliders SQI). |
| `BandpassFilter` ahora es wrapper de `BandpassBiquad` (`src/modules/signal-processing/biquadFilter.ts`) | Había dos implementaciones Butterworth biquad casi idénticas. |
| `HeartBeatProcessor`: FFT/Welch throttled a ~3 Hz + ventana Hann cacheada | El hotspot del main thread (allocs por frame) se redujo sin cambiar la salida (el BPM se suaviza por EMA). |
| `PPGSignalMeter`: bucle RAF único con throttle + buffer 840×1680 | El doble bucle RAF dibujaba ~90 fps sobre un buffer 1400×2800; ahora 30 fps sobre 3.5× menos píxeles. |

## Base literaria del pipeline único (validada en web)

| Componente | Referencia | Implementación |
|---|---|---|
| Fusión POS (proyección ortogonal al tono de piel) | Wang et al., *Algorithmic Principles of Remote PPG*, IEEE TBME 2017 (benchmark: mejor rendimiento global; supera PCA/ICA/CHROM/PBV/2SR en robustez) | `PPGSignalProcessor.computePOS` |
| Ventana POS adaptativa | Wang 2017: l ≈ fps × 1.6 s (≥1 ciclo cardíaco) | Ventana dinámica según FPS medido (antes fija 32) |
| Canal verde + multi-canal | Verkruysse et al. 2008 (verde = mayor modulación PPG) | Fuentes R / G / RG / POS con ranking competitivo e histéresis |
| Filtrado pasabanda Butterworth 0.3–5 Hz (18–300 bpm) | Elgendi et al. 2013; práctica estándar rPPG | `biquadFilter.ts` (2 biquads TDF-II) |
| Detección de picos: umbral adaptativo + prominencia + período refractario + search-back | van Gent et al. 2019 (adaptación de Pan-Tompkins a PPG); Elgendi 2013 | `HeartBeatProcessor.detectPeak` |
| BPM tiempo+frecuencia (Welch PSD) | Elgendi 2013; estándar de apps de móvil validadas | `estimatePeriodicity` + EMA con gate de picos confirmados |
| SQI con gate de perfusión AC/DC | Verkruysse 2008 (AC/DC); práctica clínica de pulsioximetría | `calculateSignalQuality` + `calculatePerfusionIndex` |

## Mapa de dependencias actual (limpio)

```
CameraView (MediaStream + torch)
   │ requestVideoFrameCallback
   ▼
useSignalProcessor → PPGSignalProcessor
   │   • extractROI (5×5 tiles, exclusión de saturados)
   │   • multi-source (R / G / RG / POS dinámico)
   │   • BandpassFilter (wrapper de BandpassBiquad, Butterworth 0.3–5 Hz IIR)
   │   • SQI unificado, perfusion index, contact state
   ▼
ProcessedSignal
   │
   ├─► useHeartBeatProcessor → HeartBeatProcessor (peak detection, BPM)
   │
   └─► useVitalSignsProcessor → VitalSignsProcessor
           ├─ SpO2 (R/G ratio)
           ├─ BloodPressureProcessor (PWA + 74 features)
           ├─ PPGFeatureExtractor (cycles, RR variability)
           └─ ArrhythmiaProcessor (RR intervals)
   ▼
Index.tsx (UI)
   ├─► PPGSignalMeter (oscilloscope canvas, full-screen)
   ├─► VitalSign × N (con `--` cuando valor = 0)
   └─► useSaveMeasurement (Supabase persist al finalizar 60s)

Pipeline avanzado opcional (Ajustes → "Advanced engine"): src/lib/ppg/**
   usePpgCapture → worker ppgWorker (PCA + bandpass + SQI) — solo diagnóstico.
```

## Verificación tras limpieza

- `check:orphans` → OK (se arregló el falso positivo de imports `?worker` de Vite).
- `check:no-sim` (source) → OK. Se arregló el scanner: los marcadores `// anti-sim-allow:` no se reconocían en archivos CRLF (`.` no cruza `\r`), lo que disparaba un falso positivo en `vitalsSanity.ts:1`.
- `check:no-sim:dist` → OK (2 archivos / 532.9 KB escaneados tras build).
- `npm run lint` → 0 errores (eran ~47 en la línea base: `any`, `no-empty`, `no-case-declarations`, `require()` en tailwind; todos corregidos).
- `npm run typecheck` sin errores.
- `npm run build` → OK (último build 2.9s).
- `npm test` → 20 tests pasando (incluidos los 5 de `BandpassFilter` tras el wrapper).
- Cada archivo restante en `src/` está importado por al menos otro archivo (excepto `App.tsx` y `main.tsx` que son entry-points, y los `.d.ts` que son ambient types).

## Inventario final

- **Páginas:** `Index.tsx`, `NotFound.tsx`
- **Componentes:** `CameraView`, `PPGSignalMeter`, `VitalSign` + UI primitives (toast hook)
- **Hooks:** `useSignalProcessor`, `useHeartBeatProcessor`, `useVitalSignsProcessor`, `useHealthAnalysis`, `useSaveMeasurement`, `usePerfTelemetry`, `use-toast`
- **Módulos signal-processing:** `PPGSignalProcessor`, `BandpassFilter`, `biquadFilter`
- **Módulos vital-signs:** `VitalSignsProcessor`, `BloodPressureProcessor`, `PPGFeatureExtractor`, `arrhythmia-processor`
- **Módulos:** `HeartBeatProcessor`
- **Utils:** `arrhythmiaUtils`, `soundUtils`, `CircularBuffer`, `lib/utils`, `logger`
- **Tipos:** `signal.d.ts`, `media-stream.d.ts`, `screen-orientation.d.ts`, `vite-env.d.ts`
- **Integración:** `supabase/client.ts`, `supabase/types.ts`

No queda código duplicado, obsoleto, ni APIs no-op. El cableado es lineal y unidireccional.

