/** QR display and camera scanning for pairing codes. */
import jsQR from "jsqr";
import QRCode from "qrcode";
import { SyncError } from "./errors";

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  getSupportedFormats?: () => Promise<string[]>;
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}

const SCAN_WIDTH = 640;

export async function drawQrCode(
  canvas: HTMLCanvasElement,
  text: string
): Promise<void> {
  try {
    await QRCode.toCanvas(canvas, text, {
      errorCorrectionLevel: "L",
      margin: 1,
      width: Math.max(160, Math.min(canvas.clientWidth || 320, 512)),
    });
  } catch {
    throw new SyncError(
      "code_too_long",
      "This code is too long for a QR image. Share it as text instead."
    );
  }
}

export interface QrScanner {
  start(): Promise<void>;
  stop(): void;
}

function barcodeDetector(): BarcodeDetectorLike | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor })
    .BarcodeDetector;
  if (!ctor) {
    return null;
  }
  try {
    return new ctor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

export function createQrScanner(
  video: HTMLVideoElement,
  onResult: (text: string) => void
): QrScanner {
  let stream: MediaStream | null = null;
  let frame = 0;
  let active = false;
  const detector = barcodeDetector();
  const canvas =
    typeof document === "undefined" ? null : document.createElement("canvas");

  const stop = () => {
    active = false;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      stream = null;
    }
    video.srcObject = null;
  };

  const decodeWithCanvas = (): string | null => {
    if (!(canvas && video.videoWidth)) {
      return null;
    }
    const scale = Math.min(1, SCAN_WIDTH / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return null;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return (
      jsQR(image.data, image.width, image.height, {
        inversionAttempts: "dontInvert",
      })?.data ?? null
    );
  };

  const tick = async () => {
    if (!active) {
      return;
    }
    let text: string | null = null;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      if (detector) {
        try {
          text = (await detector.detect(video))[0]?.rawValue ?? null;
        } catch {
          text = decodeWithCanvas();
        }
      } else {
        text = decodeWithCanvas();
      }
    }
    if (!active) {
      return;
    }
    if (text) {
      stop();
      onResult(text);
      return;
    }
    schedule();
  };

  /** `tick` only rejects on a broken video element; stopping is the safe reaction. */
  const schedule = () => {
    frame = requestAnimationFrame(() => {
      tick().catch(stop);
    });
  };

  return {
    async start() {
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        throw new SyncError(
          "camera_unavailable",
          "This browser cannot open the camera. Paste the code instead."
        );
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" } },
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        throw new SyncError(
          name === "NotAllowedError" ? "camera_denied" : "camera_unavailable",
          name === "NotAllowedError"
            ? "Camera access was denied. Paste the code instead."
            : "No camera is available. Paste the code instead."
        );
      }
      video.srcObject = stream;
      video.setAttribute("playsinline", "true");
      video.muted = true;
      await video.play();
      active = true;
      schedule();
    },
    stop,
  };
}

/** Hand the code to the share sheet, else the clipboard. Returns whether either worked. */
export async function shareCode(text: string): Promise<boolean> {
  if (typeof navigator === "undefined") {
    return false;
  }
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ text });
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return false;
      }
    }
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
