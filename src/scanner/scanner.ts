import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

export interface ScannerHandle {
  stop(): void;
  setTorch(on: boolean): Promise<boolean>;
  torchSupported: boolean;
  engine: 'nativo' | 'zxing';
}

const ZXING_FORMATS = [
  BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.ITF,
  BarcodeFormat.CODABAR, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX,
];
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar',
  'qr_code', 'data_matrix'];

const VIDEO_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    // enfoque continuo cuando el dispositivo lo soporta
    advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
  },
};

export function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
}

function trackOf(video: HTMLVideoElement): MediaStreamTrack | undefined {
  return (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
}

function torchCapable(video: HTMLVideoElement): boolean {
  const t = trackOf(video);
  const caps = t && typeof t.getCapabilities === 'function' ? (t.getCapabilities() as any) : {};
  return !!caps.torch;
}

async function applyTorch(video: HTMLVideoElement, on: boolean): Promise<boolean> {
  const t = trackOf(video);
  if (!t) return false;
  try {
    await t.applyConstraints({ advanced: [{ torch: on } as any] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Inicia la cámara trasera y llama onCode cada vez que lee un código.
 * Usa BarcodeDetector nativo (Chrome Android, rápido) si existe; si no, ZXing (iPhone/Safari y otros).
 */
export async function startScanner(video: HTMLVideoElement, onCode: (text: string, format: string) => void): Promise<ScannerHandle> {
  const Native = (window as any).BarcodeDetector;
  if (Native && typeof Native.getSupportedFormats === 'function') {
    try {
      const supported: string[] = await Native.getSupportedFormats();
      const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
      if (formats.includes('ean_13') && formats.includes('code_128')) {
        return await startNative(video, new Native({ formats }), onCode);
      }
    } catch {
      /* se usa ZXing */
    }
  }
  return startZxing(video, onCode);
}

async function startNative(video: HTMLVideoElement, detector: any, onCode: (t: string, f: string) => void): Promise<ScannerHandle> {
  const stream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  video.muted = true;
  await video.play();
  let stopped = false;
  let busy = false;
  const timer = window.setInterval(async () => {
    if (stopped || busy || video.readyState < 2) return;
    busy = true;
    try {
      const codes = await detector.detect(video);
      if (codes.length && !stopped) onCode(codes[0].rawValue, codes[0].format);
    } catch {
      /* frame inválido */
    } finally {
      busy = false;
    }
  }, 120);
  return {
    engine: 'nativo',
    torchSupported: torchCapable(video),
    setTorch: (on) => applyTorch(video, on),
    stop() {
      stopped = true;
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

async function startZxing(video: HTMLVideoElement, onCode: (t: string, f: string) => void): Promise<ScannerHandle> {
  const hints = new Map<DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, ZXING_FORMATS],
    [DecodeHintType.TRY_HARDER, true],
  ]);
  const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 100, delayBetweenScanSuccess: 300 });
  video.setAttribute('playsinline', 'true');
  video.muted = true;
  const controls: IScannerControls = await reader.decodeFromConstraints(VIDEO_CONSTRAINTS, video, (result) => {
    if (result) onCode(result.getText(), BarcodeFormat[result.getBarcodeFormat()] ?? '');
  });
  return {
    engine: 'zxing',
    torchSupported: !!controls.switchTorch || torchCapable(video),
    async setTorch(on) {
      if (controls.switchTorch) {
        try {
          await controls.switchTorch(on);
          return true;
        } catch {
          return false;
        }
      }
      return applyTorch(video, on);
    },
    stop: () => controls.stop(),
  };
}

/** Evita registrar el mismo código varias veces mientras sigue frente a la cámara. */
export function createDebouncer(ms = 1500) {
  let last = '';
  let lastAt = 0;
  return (code: string): boolean => {
    const now = Date.now();
    if (code === last && now - lastAt < ms) {
      lastAt = now;
      return false;
    }
    last = code;
    lastAt = now;
    return true;
  };
}

// ---------- retroalimentación ----------
let audioCtx: AudioContext | null = null;

/** Debe llamarse dentro de un gesto del usuario (iOS exige desbloquear el audio). */
export function unlockAudio(): void {
  try {
    audioCtx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch {
    /* sin audio */
  }
}

export function beep(kind: 'ok' | 'warn' = 'ok'): void {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = 'square';
  o.frequency.value = kind === 'ok' ? 1650 : 440;
  g.gain.value = 0.08;
  o.connect(g).connect(audioCtx.destination);
  const t = audioCtx.currentTime;
  o.start(t);
  o.stop(t + (kind === 'ok' ? 0.09 : 0.25));
}

export function vibrate(kind: 'ok' | 'warn' = 'ok'): void {
  if ('vibrate' in navigator) navigator.vibrate(kind === 'ok' ? 60 : [80, 60, 80]);
}
