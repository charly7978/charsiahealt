import type {
  CameraDiagnostics,
  CameraStartResult,
  PpgCaptureState,
} from "../types";
import { extractCapabilities, extractSettings } from "./cameraCapabilities";

/**
 * Resolution / frame-rate fallback ladder. Tried in order until one succeeds.
 * iOS Safari ignores `exact`, so all entries use `ideal` and a `min`.
 */
const CONSTRAINT_LADDER: ReadonlyArray<MediaTrackConstraints> = [
  {
    facingMode: { ideal: "environment" },
    width: { ideal: 1280, min: 640 },
    height: { ideal: 720, min: 480 },
    frameRate: { ideal: 60, min: 30 },
  },
  {
    facingMode: { ideal: "environment" },
    width: { ideal: 1280, min: 640 },
    height: { ideal: 720, min: 480 },
    frameRate: { ideal: 30, min: 24 },
  },
  {
    facingMode: { ideal: "environment" },
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 30, min: 24 },
  },
  {
    facingMode: { ideal: "environment" },
  },
];

export class CameraController {
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private state: PpgCaptureState = "idle";

  getState(): PpgCaptureState {
    return this.state;
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  async start(): Promise<CameraStartResult> {
    this.state = "starting";
    let lastError: unknown = null;

    for (const video of CONSTRAINT_LADDER) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video,
        });
        const track = stream.getVideoTracks()[0];
        if (!track) {
          stream.getTracks().forEach((t) => t.stop());
          continue;
        }
        this.stream = stream;
        this.track = track;
        const diagnostics = await this.applyAdvancedConstraints(track);
        const capabilities = extractCapabilities(track);
        const settings = extractSettings(track);
        this.state = diagnostics.degraded ? "degraded" : "running";
        return {
          stream,
          track,
          state: this.state,
          diagnostics,
          capabilities,
          settings,
        };
      } catch (err) {
        lastError = err;
      }
    }

    this.state = "error";
    throw lastError instanceof Error
      ? lastError
      : new Error("Camera initialization failed across all fallbacks.");
  }

  /**
   * Each advanced constraint is isolated in its own try/catch so an iOS-Safari
   * rejection of (e.g.) `torch` cannot abort the rest of the configuration.
   * The capture continues with whichever locks the platform accepted.
   */
  private async applyAdvancedConstraints(
    track: MediaStreamTrack,
  ): Promise<CameraDiagnostics> {
    const caps = extractCapabilities(track);
    const notes: string[] = [];
    let torch = false;
    let focusManual = false;
    let exposureManual = false;
    let whiteBalanceManual = false;

    if (caps.torch) {
      // Some Android devices reject torch immediately after acquisition.
      // Retry with a short backoff before giving up.
      for (const delay of [0, 200, 500] as const) {
        try {
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          await track.applyConstraints({
            advanced: [{ torch: true } as MediaTrackConstraintSet],
          });
          torch = true;
          break;
        } catch {
          // try next backoff
        }
      }
      if (!torch) notes.push("torch_rejected");
    } else {
      notes.push("torch_unsupported");
    }

    if (caps.focusModes.includes("manual")) {
      try {
        await track.applyConstraints({
          advanced: [{ focusMode: "manual" } as MediaTrackConstraintSet],
        });
        focusManual = true;
      } catch {
        notes.push("focus_manual_rejected");
      }
    }

    if (caps.exposureModes.includes("manual")) {
      try {
        await track.applyConstraints({
          advanced: [{ exposureMode: "manual" } as MediaTrackConstraintSet],
        });
        exposureManual = true;

        // Lock exposureTime to ~28ms (≈85% of 1/30s) — maximizes SNR
        // without clipping. Without this, AGC keeps changing gain and
        // injects 0.1–2 Hz noise into the cardiac band.
        const rawCaps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
        const etRange = rawCaps["exposureTime"] as { min: number; max: number } | undefined;
        if (etRange && typeof etRange.min === "number" && typeof etRange.max === "number") {
          const targetEt = Math.round(Math.min(etRange.max, Math.max(etRange.min, 28000)));
          try {
            await track.applyConstraints({
              advanced: [{ exposureTime: targetEt } as MediaTrackConstraintSet],
            });
          } catch {
            notes.push("exposure_time_rejected");
          }
        }

        // Lock ISO at the midpoint of the supported range to stop AGC drift.
        const isoRange = rawCaps["iso"] as { min: number; max: number } | undefined;
        if (isoRange && typeof isoRange.min === "number" && typeof isoRange.max === "number") {
          const targetIso = Math.round((isoRange.min + isoRange.max) / 2);
          try {
            await track.applyConstraints({
              advanced: [{ iso: targetIso } as MediaTrackConstraintSet],
            });
          } catch {
            notes.push("iso_rejected");
          }
        }
      } catch {
        notes.push("exposure_manual_rejected");
      }
    }

    if (caps.whiteBalanceModes.includes("manual")) {
      try {
        await track.applyConstraints({
          advanced: [
            { whiteBalanceMode: "manual" } as MediaTrackConstraintSet,
          ],
        });
        whiteBalanceManual = true;
      } catch {
        notes.push("white_balance_manual_rejected");
      }
    }

    const settings = extractSettings(track);
    const degraded = !torch || notes.length > 0;

    return {
      torch,
      focusManual,
      exposureManual,
      whiteBalanceManual,
      width: settings.width,
      height: settings.height,
      frameRate: settings.frameRate,
      degraded,
      notes,
    };
  }

  async stop(): Promise<void> {
    if (this.track) {
      try {
        if (extractCapabilities(this.track).torch) {
          await this.track.applyConstraints({
            advanced: [{ torch: false } as MediaTrackConstraintSet],
          });
        }
      } catch {
        // torch may not be controllable on shutdown; ignore.
      }
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
    }
    this.stream = null;
    this.track = null;
    this.state = "idle";
  }
}
