# Bloqueo del falso positivo "objeto rojo = dedo humano"

## Diagnóstico del problema

Hoy la detección de dedo se basa **solo en color** (rojo dominante + brillo + cobertura + flash):

- `detectFingerInstant()` en `PPGSignalProcessor.ts` valida `R > 80`, `R/G > 1.2`, `R - (G+B)/2 > 20`, cobertura, `fingerScore`. **Cualquier plástico rojo bajo flash cumple esto** — la firma de hemoglobina por color no distingue piel viva de pigmento inerte.
- Una vez que pasa al estado `STABLE_CONTACT`, el gate aguas abajo (`stableHumanSignal` en `Index.tsx`) solo pide `quality >= 12` y `perfusionIndex >= 0.005`. Esos umbrales se llenan con ruido residual del AGC de cámara + micro‑movimientos de la mano, y el `BandpassFilter` (0.5–4 Hz) deja pasar cualquier oscilación lenta. El detector de picos entonces fabrica latidos sobre ruido, y `VitalSignsProcessor` empieza a publicar SpO₂/PA/glucosa/lípidos.
- No existe ninguna comprobación de **pulsatilidad real** ni de **periodicidad cardíaca sostenida** antes de declarar contacto válido.

Esto contradice la promesa del producto. La regla correcta no es "no medir si no hay dedo" — la app **siempre captura y reporta** — pero **debe reportar honestamente**: con un objeto rojo el sistema tiene que mostrar el modo `RESEARCH_ONLY` / `INVALID` con vitales en `--`, y un mensaje técnico que diga "señal no humana / sin pulsatilidad cardíaca", nunca BPM/SpO₂/PA fabricados.

## Objetivo

Añadir una **Liveness Gate** real, multi‑evidencia, que un objeto rojo inerte no pueda aprobar nunca, sin tocar UI/estética. La app sigue corriendo el pipeline 100% del tiempo; lo único que cambia es cuándo se permite **emitir vitales** y cuándo el `MeasurementGate` los marca como `INVALID` con motivo explícito.

## Cambios

### 1. `src/modules/signal-processing/PPGSignalProcessor.ts` — Liveness multi‑evidencia

Añadir un `LivenessEvaluator` privado que mantenga ventanas cortas (~4 s) sobre el canal verde filtrado y produzca un veredicto por frame. Para que `STABLE_CONTACT` se conceda **además** de los criterios cromáticos actuales, se exige TODO lo siguiente, sostenido durante ≥2 s:

- **AC/DC mínima fisiológica**: `(rojoAC / rojoDC) >= 0.0015` Y `(verdeAC / verdeDC) >= 0.0010`. Los objetos inertes tienen `AC/DC ≈ 0` salvo ruido de cámara, que no llega a estos niveles bajo flash bloqueado.
- **Pulsatilidad temporal** (no DC pura): varianza de la señal bandpassed normalizada por su DC en un rango cardíaco plausible.
- **Periodicidad cardíaca**: pico de autocorrelación dominante en lag correspondiente a 40–200 BPM (0.3–1.5 s) con altura ≥0.35 sobre el pico de ruido. Los objetos inertes producen autocorrelación plana o dominada por la respiración/movimiento (<0.5 Hz).
- **Coherencia espectral**: relación de potencia en banda 0.7–4 Hz vs banda 0–0.5 Hz (drift) ≥ 0.6.
- **Variabilidad inter‑latido aceptable**: cuando el detector de picos engancha, los IBI no pueden ser todos idénticos (firma de simulación) ni dispersos > 40% del IBI medio.

Salida del evaluador: `livenessScore ∈ [0,1]` y `livenessReason: 'OK' | 'NO_PULSATILITY' | 'NO_PERIODICITY' | 'DRIFT_ONLY' | 'CONSTANT_IBI' | 'INERT_DC'`.

Integración en `updateContactState`:
- `STABLE_CONTACT` requiere `instantDetected && livenessScore >= 0.6` durante ≥`STABLE_THRESHOLD` frames.
- Si liveness cae `<0.4`, degradar inmediatamente a `UNSTABLE_CONTACT` (sin esperar `FINGER_LOST_FRAMES`) con `livenessReason` propagado.
- Exponer `livenessScore`, `livenessReason` en el `ProcessedSignal` (campo nuevo, retro‑compatible).

### 2. `src/pages/Index.tsx` — Gate de emisión honesto

- Reemplazar `stableHumanSignal` por `humanPlausibility = stableContact && livenessScore >= 0.55 && perfusionIndex >= 0.008 && quality >= 25`. Subir umbrales para evitar que ruido residual del AGC los cruce.
- Cuando `humanPlausibility === false`:
  - Mantener la captura, el waveform y los diagnósticos visibles (sin tocar UI).
  - Forzar `vitals.measurementConfidence = 'INVALID'`, vitales en cero, BPM en `--`.
  - Mostrar en el panel técnico ya existente el motivo (`livenessReason`) y el `livenessScore`. Sin nuevos componentes visuales: usar el bloque `advanced.*` actual.
- Bloquear el guardado de la sesión (`useSaveMeasurement`) si nunca hubo `humanPlausibility === true` durante la ventana de 60 s; en su lugar, registrar la sesión como `quality = 'NO_HUMAN_SIGNAL'` para auditoría.

### 3. `src/modules/vital-signs/VitalSignsProcessor.ts` — Cinturón de seguridad

- En `processSignal`, exigir `livenessScore >= 0.55` (recibido del input ampliado) para promover `measurementConfidence` por encima de `INVALID`. Hoy ya existe `MeasurementGate`; sumar `liveness` como precondición dura para SpO₂, PA, glucosa y lípidos.
- No tocar las fórmulas ni la calibración: solo el gate.

### 4. Tests de regresión

Crear `src/modules/signal-processing/__tests__/Liveness.test.ts`:

- **Caso A — DC puro (objeto rojo inerte)**: alimentar 6 s de señal con R/G/B constantes y ruido gaussiano de σ=0.5 sobre 250. Esperar `livenessScore < 0.2`, `livenessReason ∈ {INERT_DC, NO_PULSATILITY}`, `contactState !== 'STABLE_CONTACT'`.
- **Caso B — sinusoide cardíaca sintética**: 1.2 Hz sobre DC=180 con amplitud 4. Esperar `livenessScore >= 0.7` y `STABLE_CONTACT` tras los frames de confirmación.
- **Caso C — drift lento sin pulso** (0.3 Hz): esperar `livenessReason === 'DRIFT_ONLY'`.
- **Caso D — IBI constante** (señal cuadrada perfecta): esperar `livenessReason === 'CONSTANT_IBI'`.

Ampliar `HeartBeatProcessor.regression.test.ts` para confirmar que con `livenessScore=0` el flujo aguas arriba no promueve vitales.

### 5. Tipos

- Extender `ProcessedSignal` (`src/types/signal.d.ts`) con `livenessScore: number; livenessReason: string;`.
- Extender el snapshot del worker / `PpgSignalSnapshot` solo si Index.tsx lo necesita; preferiblemente mantener la liveness exclusivamente en el path legado (`PPGSignalProcessor`) que ya alimenta los vitales — el worker avanzado se queda como diagnóstico.

## Detalles técnicos

- Toda la matemática nueva (autocorrelación, AC/DC, varianza espectral) usa `Float64Array` con `NumericRingBuffer` ya existente — sin GC en hot path.
- Autocorrelación de 4 s a Fs≈30 Hz = 120 muestras, lags 9–45: O(n·k) ≈ 4 320 ops/frame, despreciable.
- Sin cambios de diseño visual ni de paleta. Sin nuevos botones. Solo se enriquece el panel técnico avanzado existente y el motivo de `INVALID` que ya muestra el bloque de vitales.
- Sin simulaciones, sin `Math.max` para forzar rangos, sin defaults fabricados — coherente con las memorias del proyecto.

## Resultado esperado

- Con dedo: comportamiento idéntico, latencia de adquisición similar (1–2 s extra solo cuando la señal es marginal).
- Con objeto rojo / pared roja / dedo sin flash: BPM en `--`, SpO₂/PA/glucosa/lípidos en `--`, panel técnico explica `INVALID — NO_PULSATILITY` o `INERT_DC`. La app sigue capturando y mostrando waveform plano.
- Tests verdes y `tsc` limpio.
