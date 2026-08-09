# Mapa y Auditoría Completa de la Pantalla Principal

## 1. Mapa de capas y entrypoints

- Entry: `src/pages/Index.tsx`
- Orquestador de UI: `src/pages/Index.tsx`
- Monitor cardíaco principal: `src/components/PPGSignalMeter.tsx`
- Captura de cámara: `src/components/CameraView.tsx`
- Componente auxiliar de vitales: `src/components/VitalSign.tsx`
- Tipos centrales: `src/types/signal.d.ts`
- Procesamiento de señal: `src/modules/signal-processing/PPGSignalProcessor.ts`
- Detección de latidos: `src/modules/AdvancedBeatDetector.ts`
- Hooks principales: `src/hooks/useHeartBeatProcessor.ts`, `useSignalProcessor.ts`, `useVitalSignsProcessor.ts`, `useHealthAnalysis.ts`, `useSaveMeasurement.ts`, `usePerfTelemetry.ts`

## 2. Flujo de datos principal

- `Index.tsx` crea y coordina los procesadores/hooks.
- `useSignalProcessor` procesa frames de cámara y expone `lastSignal`.
- `useHeartBeatProcessor` consume `lastSignal.filteredValue` y devuelve BPM/confidence/arrhythmia.
- `useVitalSignsProcessor` calcula SpO2/PA/etc a partir de la señal y RGB stats.
- `PPGSignalMeter` recibe métricas en tiempo real y pinta el canvas.
- `CameraView` expone el stream de video a `Index.tsx`.

## 3. Errores detectados y correcciones aplicadas

### 3.1 `src/components/PPGSignalMeter.tsx`
- Síntoma: `Property 'COLORS' does not exist on type '...'`
- Acción recomendada: corregir el objeto de constantes/colores en ese archivo o usar el token correcto.

### 3.2 Paths de tipos en `src/modules/AdvancedBeatDetector.ts`
- Síntoma: uso de alias `@/types/signal` con `@ts-expect-error`
- Acción recomendada: normalizar el import a la ruta relativa correcta o resolver el alias en `tsconfig.app.json`.

## 4. Auditoría de `Index.tsx`

### 4.1 Mapa jerárquico
- `Index.tsx` es un orquestador grande con múltiples `useEffect`, modales y callbacks.
- Recibe/hijo: `PPGSignalMeter`, `CameraView`, `VitalSign`.
- Estado local abundante: `isMonitoring`, `isCameraOn`, `vitalSigns`, `heartRate`, `showResults`, `showSettings`, `showAIAnalysis`, medición/resumen.
- Sin estado global observable tipo Redux/Zustand; coordinación por callbacks y estado local.

### 4.2 Problemas arquitectónicos
- Archivo muy grande: riesgo de acoplamiento alto.
- Varios efectos con dependencias amplias.
- Posibles condiciones de carrera en refs compartidos.
- Document event listeners en body sin validación estricta.

### 4.3 Recomendaciones
- Dividir `Index.tsx` en módulos/orquestadores más pequeños.
- Aislar lógica de cámara, telemetría, medición y UI modals.
- Centralizar configuración de constantes mágicas.

## 5. Auditoría de `PPGSignalMeter.tsx`

### 5.1 Estructura
- ~1064 líneas.
- Subfunciones internas grandes: `draw3DStage`, `drawAnalyticsBand`, `drawMetricsRow`, `drawHeader`, `drawFooter`.
- `CircularBuffer` como estructura de datos principal.
- Loop de render con `requestAnimationFrame`.
- `propsRef` y múltiples refs para estado mutable del canvas.

### 5.2 Problemas detectados
- Tamaño muy grande; difícil de mantener.
- Draw stages muy largos.
- drawECGGrid usa nombres ambiguos como `strokePass` y reutiliza variables.
- draw3DStage es muy extenso y concentra lógica.
- Posibles race conditions entre props, refs y loop de animación.
- drawAnalyticsBand repite patrones de métricas.

### 5.3 Recomendaciones
- Separar por capas: `draw3DStage`, `drawAnalyticsBand`, `drawMetricsRow` en archivos propios o subcomponentes.
- Extraer utilidades de dibujo comunes.
- Introducir `ResizeObserver` o ajuste responsivo explícito del canvas.
- Considerar `useMemo` para objetos costosos de dibujo.
- Añadir manejo de errores en el loop de render para no bloquear el monitor.

## 6. Auditoría de hooks

### 6.1 `useHeartBeatProcessor`
- Ahora usa `AdvancedBeatDetector` en vez de `HeartBeatProcessor`.
- Estado: BPM, confidence, signalQuality.
- Refuerzo de NO_CONTACT con umbral sostenido.
- Posibles lecturas de refs sin defensa ante null.

### 6.2 `useSignalProcessor`
- Provee `lastSignal`, `getBackpressureState`, `getRGBStats`.
- Manejo de backpressure por stride.
- Debe garantizar cleanup de cámara, buffers y RAF en desmontaje.

### 6.3 `useVitalSignsProcessor`
- Consume señal y RGB stats.
- Produce `lastValidResults` usados por UI y resumen final.

### 6.4 Problemas transversales
- Vários `useEffect` amplios pueden causar rerenders innecesarios.
- Timers/intervals deben limpiarse de forma uniforme.
- `lastValidResults` puede sincronizarse con estados no actualizados.

## 7. Recomendaciones generales

1. Corregir `COLORS` en `PPGSignalMeter.tsx`.
2. Normalizar imports de tipos en módulos nuevos.
3. Partir `PPGSignalMeter.tsx` en capas de dibujo.
4. Partir `Index.tsx` en orquestadores menores.
5. Añadir tests unitarios por capa de dibujo y por hook.
6. Centralizar constantes y umbrales.
7. Añadir manejo de errores explícito en canvas y cámara.