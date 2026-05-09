# Por qué hoy aparecen ondas y vitales "lindos" sin dedo

Aunque ya removimos el bloqueo por liveness, el sistema sigue *fabricando* señales plausibles a partir de cualquier escena por **3 mecanismos acumulativos**:

1. **Pseudo‑pulso por baseline EMA** (`PPGSignalProcessor.extractBestPulseSignal`)
   - Se construye `rNorm = (redBaseline − rawRed) / redBaseline`, con `redBaseline` siguiendo a `rawRed` con `α = 0.02–0.04`. La diferencia entre la media lenta y el valor instantáneo es **siempre una oscilación de ~0.7–4 Hz** (justo la banda cardíaca), aún apuntando a una pared. Después se multiplica por **3200** y se mete al bandpass: lo que sale parece una onda PPG perfecta.

2. **Suavizado y retención en `VitalSignsProcessor`**
   - `EMA_ALPHA_STABLE = 0.20`, `EMA_ALPHA_DYNAMIC = 0.30`. Una vez que entró un valor "razonable" (SpO₂ entre 70–100, glucosa 40–400, etc.), el EMA lo conserva visible aunque la entrada se vuelva basura.
   - `getFormattedResult()` siempre devuelve el último `measurements.*` aunque `validateRealPulse` falle (no se ponen a 0).

3. **Gates que se cumplen con ruido**
   - `stableHumanSignal` solo pide `quality ≥ 12` y `perfusionIndex ≥ 0.005`. El ruido del AGC + flash sobre cualquier objeto los cumple.
   - El detector de picos (`HeartBeatProcessor`) tiene `prominence ≥ 2.2` sobre señal **ya normalizada × 120**: el ruido amplificado lo supera trivialmente.

Resultado: la app reporta lo que *parece* un humano sano porque el propio pipeline está diseñado para alisar y sostener.

# Plan: modo "crudo total + solo bruto"

Tu decisión:
- **Salida visible: Crudo total** → seguir mostrando ondas y métricas siempre, aunque sean absurdas.
- **Tratamiento: Solo bruto** → quitar EMA y retención; cada valor en pantalla es el cálculo directo del frame/ventana actual.

## Cambios

### 1. `PPGSignalProcessor.extractBestPulseSignal` — quitar el "pulso fabricado"
- Eliminar la división por baseline EMA. La señal cruda emitida será la **verdadera intensidad media del canal** (R, G o RG) **sin restar baseline** y **sin multiplicar × 3200**.
- El `BandpassFilter` se queda — es el que convierte cualquier DC en oscilación honesta. Pero ya no estará alimentado con un "diff vs media móvil" (que es matemáticamente un pseudo‑pulso garantizado).
- `pulseSource.strength` será la varianza real corta (std en ventana de 30 muestras) del canal seleccionado, no `|rPulse|·1000`.

### 2. `Index.tsx` — siempre emitir, sin gate `stableHumanSignal`
- Eliminar `stableHumanSignal` y el contador `unstableFrameCounter`. El bloque que pone vitales a 0/`INVALID` se borra.
- `setHeartbeatSignal(heartBeatResult.filteredValue)` siempre — la onda se pinta venga de donde venga.
- `setHeartRate(heartBeatResult.bpm)` siempre, aunque sea 0 o errático. Sin sanity gate "freezing".
- `processVitalSigns(...)` se llama siempre con los `rrData` que produzca el `HeartBeatProcessor`, sin filtrar por `confidence > 0.18`.
- El `VitalsSanityChecker` deja de **bloquear** la actualización: solo registra el verdict para auditoría (toast/log), pero los números mostrados son los crudos del frame.

### 3. `VitalSignsProcessor` — eliminar EMA y retención
- `smoothValue(...)` queda en passthrough: `return raw`. SpO₂, BP, glucosa, hemoglobina, lípidos se actualizan con el cálculo directo de la ventana actual.
- `getFormattedResult()`: si la última iteración no produjo un valor (no hubo ciclos / RR insuficientes), devolver **0** para esa métrica en vez del previo. Sin "soft hold".
- Quitar la guarda `if (!hasRealPulse) return getFormattedResult()` que congelaba previos: si no hay pulso, todo a 0 ese frame.
- Eliminar las ventanas de validación (`spo2 > 70 && < 100`, etc.) que **descartaban** valores extremos: ahora se publica el número crudo, sea 42 o 187. Esto es exactamente el "ver la realidad" que pediste.

### 4. `HeartBeatProcessor` — quitar suavizado de BPM
- Reemplazar `smoothBPM` por `instantBPM = 60000 / lastIBI` directamente.
- Quitar el blend tiempo+frecuencia (`displayBPM = ... * 0.88 + frequencyBPM * 0.12`). Devolver solo el BPM instantáneo del último intervalo válido. Si no hay último intervalo: 0.
- Mantener `MIN_PEAK_INTERVAL_MS` y la detección de picos como están — no toco el detector, solo dejo de mentir alisando.

### 5. UI — etiqueta de modo
- En el panel técnico ya existente (`advanced.*` / debug), añadir una línea visible permanente:
  `MODO: CRUDO — sin EMA, sin gates, sin retención`
  para que quede claro que lo que se ve es exactamente lo que el algoritmo decodifica frame a frame.

## Lo que NO cambia
- Captura de cámara, ROI, `BandpassFilter`, `LivenessEvaluator` (queda como telemetría informativa), `ArrhythmiaProcessor`, persistencia, UI estética.
- No se reintroducen restricciones de "no dedo = no medir". La app **siempre mide**.

## Resultado esperado
- Apuntando a una pared/objeto rojo: la onda mostrará el ruido real del sensor (mucho más errática y de menor amplitud que ahora), BPM saltará entre 0 y valores incoherentes, SpO₂/PA/glucosa cambiarán cuadro a cuadro o se quedarán en 0. Eso es la **prueba honesta** de que el algoritmo está procesando lo que llega de la cámara.
- Con dedo real + flash: el verdadero pulso fisiológico aparece como una oscilación coherente real (no fabricada por baseline‑EMA), y como tal sí produce BPM/SpO₂ estables.

## Tests
- Actualizar `HeartBeatProcessor.regression.test.ts` (snapshot) para reflejar BPM instantáneo sin EMA.
- Ajustar `Liveness.test.ts` solo para que no asuma valores suavizados.
- `tsc` limpio.
