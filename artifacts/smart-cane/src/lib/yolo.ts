// YOLO TFLite inference, using the UMD bundles loaded from index.html.
//
// We do NOT import "@tensorflow/*" packages at runtime. They're loaded as
// classic <script> tags in index.html and exposed as window.tf and
// window.tflite. This is the only reliable way to ship tfjs-tflite inside
// a Capacitor APK — bundling it via Vite/Rollup bakes the original
// node_modules URL of `tflite_web_api_client.js` into the build, which
// 404s on device and white-screens the app.
//
// BACKEND SELECTION (the most impactful performance knob):
//   The tf-core backend handles pre/post-processing (tensor creation, NMS,
//   etc.). The TFLite C++ runtime handles the actual model inference.
//
//   For tf-core pre/post-processing we try backends in this order:
//     1. "webgpu"  — uses the phone's GPU via WebGPU API. Available in
//                    Android WebView Chromium 113+. Fastest for tensor ops.
//     2. "webgl"   — uses the phone's GPU via WebGL2. Available on
//                    virtually all Android WebViews. Good GPU fallback.
//     3. "wasm"    — CPU via WebAssembly (with SIMD if supported).
//                    Reliable, works everywhere, but CPU-only.
//     4. "cpu"     — pure JS fallback. Slowest.
//
//   For the TFLite model inference itself, the C++ runtime always uses
//   its own WASM backend (with SIMD+threads when available). The
//   tf-core backend choice only affects pre/post-processing speed.
//   However, using a GPU backend for pre/post still gives a meaningful
//   speedup because tensor creation and NMS are non-trivial at 640x640.
//
// We import *types only* so the rest of the file stays type-safe.
import type * as TFCoreNS from "@tensorflow/tfjs-core";
import type * as TFLiteNS from "@tensorflow/tfjs-tflite";
import { CLASS_NAMES } from "./labels";

// Extended TF type that includes backend registration methods
// that are added by the UMD script includes (wasm, webgl, webgpu).
type TFExtended = typeof TFCoreNS & {
  wasm?: { setWasmPaths?: (path: string) => void };
  webgpu?: { register?: () => void };
  webgl?: { register?: () => void };
};

declare global {
  interface Window {
    tf?: TFExtended;
    tflite?: typeof TFLiteNS;
  }
}

function getTf(): TFExtended {
  const t = window.tf;
  if (!t) {
    throw new Error(
      "TensorFlow.js not loaded. Check that <script src=\"./tflite-wasm/tf-core.min.js\"> is in index.html and the file exists in public/tflite-wasm/.",
    );
  }
  return t;
}

function getTflite(): typeof TFLiteNS {
  const t = window.tflite;
  if (!t) {
    throw new Error(
      "tfjs-tflite not loaded. Check that <script src=\"./tflite-wasm/tf-tflite.min.js\"> is in index.html and the file exists in public/tflite-wasm/.",
    );
  }
  return t;
}

const INPUT_SIZE = 640;
// We DO NOT hard-code NUM_CLASSES from CLASS_NAMES.length any more.
// The .tflite model's actual class count is derived from its output
// tensor shape at runtime (see detect()). Hard-coding caused silent
// "Unexpected model output shape" failures whenever labels.ts and the
// trained model went out of sync — e.g. model trained on 80 COCO
// classes but labels.ts edited down to a custom 74-class list. Now we
// trust the model and just look up names from CLASS_NAMES with a
// "class_<id>" fallback for any IDs beyond the labels list.

export interface Detection {
  classId: number;
  className: string;
  confidence: number;
  // box in normalized 0..1 coords (relative to original frame)
  x: number;
  y: number;
  w: number;
  h: number;
}

let model: TFLiteNS.TFLiteModel | null = null;
let loading: Promise<TFLiteNS.TFLiteModel> | null = null;

// Which tf-core backend is currently active. Exposed so the UI can
// show the user what hardware is being used (GPU vs CPU).
let activeBackend: string = "unknown";

export function getActiveBackend(): string {
  return activeBackend;
}

// Try backends in priority order. Returns the first one that
// successfully initializes, or "cpu" as the final fallback.
async function selectBestBackend(tf: TFExtended): Promise<string> {
  const candidates = ["webgpu", "webgl", "wasm", "cpu"];

  for (const backend of candidates) {
    try {
      // Register the backend plugin if it exists but hasn't been
      // registered yet (WebGL and WebGPU are separate <script> includes
      // that self-register, but WASM needs setWasmPaths first).
      if (backend === "wasm") {
        const base = import.meta.env.BASE_URL.replace(/\/$/, "") + "/tflite-wasm/";
        tf.wasm?.setWasmPaths?.(base);
      }

      await tf.setBackend(backend);
      await tf.ready();

      // Verify the backend actually works by creating a tiny tensor.
      const test = tf.tensor1d([1, 2, 3]);
      test.dispose();

      activeBackend = backend;
      console.log(`[YOLO] tf-core backend: ${backend} (GPU: ${backend === "webgpu" || backend === "webgl"})`);
      return backend;
    } catch (e) {
      console.warn(`[YOLO] Backend "${backend}" failed:`, e);
      continue;
    }
  }

  // Should never reach here since "cpu" always works, but just in case.
  activeBackend = "cpu";
  return "cpu";
}

export async function loadModel(modelUrl: string): Promise<TFLiteNS.TFLiteModel> {
  if (model) return model;
  if (loading) return loading;

  const tf = getTf();
  const tflite = getTflite();

  // Serve all WASM blobs from the bundled /tflite-wasm/ folder so the
  // app works fully offline once installed (the cane has no internet —
  // the phone is joined to the ESP32 SoftAP).
  const base = import.meta.env.BASE_URL.replace(/\/$/, "") + "/tflite-wasm/";
  // tfjs-tflite C++ runtime path.
  tflite.setWasmPath(base);

  // Select the best available tf-core backend (GPU first, then CPU).
  await selectBestBackend(tf);

  loading = tflite
    .loadTFLiteModel(modelUrl, {
      numThreads: Math.min(4, navigator.hardwareConcurrency || 2),
    })
    .then((m) => {
      model = m;
      return m;
    });
  return loading;
}

export function isModelLoaded(): boolean {
  return model !== null;
}

// Resize+letterbox the source frame into a 640x640 RGB Float32Array (HWC, 0..1).
function preprocess(
  source: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
  scratchCanvas: HTMLCanvasElement,
): { tensor: TFCoreNS.Tensor; scale: number; padX: number; padY: number; srcW: number; srcH: number } {
  const tf = getTf();
  const srcW =
    (source as HTMLVideoElement).videoWidth ||
    (source as HTMLImageElement).naturalWidth ||
    (source as HTMLCanvasElement).width;
  const srcH =
    (source as HTMLVideoElement).videoHeight ||
    (source as HTMLImageElement).naturalHeight ||
    (source as HTMLCanvasElement).height;

  if (srcW <= 0 || srcH <= 0) {
    // MJPEG <img> hasn't decoded its first frame yet, or the camera
    // dropped off mid-stream. Throwing here lets the caller skip this
    // tick instead of crashing in tensor4d() with NaN dimensions.
    throw new Error("source not ready (zero dimensions)");
  }
  const scale = Math.min(INPUT_SIZE / srcW, INPUT_SIZE / srcH);
  const newW = Math.round(srcW * scale);
  const newH = Math.round(srcH * scale);
  const padX = Math.floor((INPUT_SIZE - newW) / 2);
  const padY = Math.floor((INPUT_SIZE - newH) / 2);

  scratchCanvas.width = INPUT_SIZE;
  scratchCanvas.height = INPUT_SIZE;
  const ctx = scratchCanvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(source, padX, padY, newW, newH);

  let imgData: Uint8ClampedArray;
  try {
    imgData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  } catch (e) {
    throw new Error(
      "Canvas tainted — cannot read pixels. If using an <img> with crossOrigin, " +
      "remove it or ensure the server sends correct CORS headers for MJPEG streams.",
    );
  }
  const data = new Float32Array(INPUT_SIZE * INPUT_SIZE * 3);
  for (let i = 0, j = 0; i < imgData.length; i += 4, j += 3) {
    data[j]     = imgData[i]     / 255;
    data[j + 1] = imgData[i + 1] / 255;
    data[j + 2] = imgData[i + 2] / 255;
  }
  const tensor = tf.tensor4d(data, [1, INPUT_SIZE, INPUT_SIZE, 3], "float32");
  return { tensor, scale, padX, padY, srcW, srcH };
}

function iou(a: Detection, b: Detection): number {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const interX1 = Math.max(a.x, b.x);
  const interY1 = Math.max(a.y, b.y);
  const interX2 = Math.min(ax2, bx2);
  const interY2 = Math.min(ay2, by2);
  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  const inter = interW * interH;
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

function nms(detections: Detection[], iouThreshold: number): Detection[] {
  detections.sort((a, b) => b.confidence - a.confidence);
  const keep: Detection[] = [];
  for (const det of detections) {
    let suppress = false;
    for (const kept of keep) {
      if (kept.classId === det.classId && iou(det, kept) > iouThreshold) {
        suppress = true;
        break;
      }
    }
    if (!suppress) keep.push(det);
  }
  return keep;
}

export async function detect(
  source: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
  scratchCanvas: HTMLCanvasElement,
  options?: { confThreshold?: number; iouThreshold?: number },
): Promise<Detection[]> {
  if (!model) throw new Error("Model not loaded yet");
  const tf = getTf();
  const confThreshold = options?.confThreshold ?? 0.4;
  const iouThreshold = options?.iouThreshold ?? 0.45;

  const { tensor, scale, padX, padY, srcW, srcH } = preprocess(source, scratchCanvas);

  let outputs: TFCoreNS.Tensor | TFCoreNS.Tensor[] | { [n: string]: TFCoreNS.Tensor };
  try {
    outputs = model.predict(tensor) as TFCoreNS.Tensor | TFCoreNS.Tensor[];
  } finally {
    tensor.dispose();
  }

  let out: TFCoreNS.Tensor;
  if (Array.isArray(outputs)) {
    out = outputs[0];
  } else if (outputs instanceof tf.Tensor) {
    out = outputs;
  } else {
    out = Object.values(outputs)[0] as TFCoreNS.Tensor;
  }

  const dims = out.shape;
  const data = (await out.data()) as Float32Array;
  out.dispose();
  if (Array.isArray(outputs)) {
    for (let i = 1; i < outputs.length; i++) (outputs as TFCoreNS.Tensor[])[i].dispose();
  }

  // Output is YOLOv8-style: one dim is 4+nc (small), the other is the
  // number of anchors (large, typically 8400 for 640x640 input). We
  // pick the smaller of the two non-batch dims as the attribute axis,
  // derive nc from it, and wire up indexing accordingly. This way the
  // .tflite is fully self-describing — labels.ts can have any length
  // (including 0) without breaking inference.
  if (dims.length !== 3 || dims[0] !== 1) {
    throw new Error(`Unexpected model output rank: shape [${dims.join(",")}]`);
  }
  const dA = dims[1]!;
  const dB = dims[2]!;
  const attrAxis = dA < dB ? 1 : 2;
  const expectedAttrs = attrAxis === 1 ? dA : dB;
  const numAnchors    = attrAxis === 1 ? dB : dA;
  const numClasses    = expectedAttrs - 4;
  // attrIsFastAxis is true iff attrs are the LAST dim ([1, A, 4+nc]).
  const attrIsFastAxis = attrAxis === 2;
  if (numClasses <= 0 || numAnchors <= 0) {
    throw new Error(`Bad model output shape [${dims.join(",")}]`);
  }

  const get = (anchor: number, attr: number): number =>
    attrIsFastAxis
      ? data[anchor * expectedAttrs + attr]
      : data[attr * numAnchors + anchor];

  let coordsAreNormalized = false;
  {
    const cx0 = get(0, 0);
    const cy0 = get(0, 1);
    const w0 = get(0, 2);
    const h0 = get(0, 3);
    const m = Math.max(Math.abs(cx0), Math.abs(cy0), Math.abs(w0), Math.abs(h0));
    coordsAreNormalized = m <= 1.5;
  }
  const coordScale = coordsAreNormalized ? INPUT_SIZE : 1;

  const detections: Detection[] = [];
  for (let i = 0; i < numAnchors; i++) {
    let bestClass = -1;
    let bestScore = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = get(i, 4 + c);
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (bestScore < confThreshold) continue;

    const cx = get(i, 0) * coordScale;
    const cy = get(i, 1) * coordScale;
    const w  = get(i, 2) * coordScale;
    const h  = get(i, 3) * coordScale;

    const x = (cx - w / 2 - padX) / scale;
    const y = (cy - h / 2 - padY) / scale;
    const bw = w / scale;
    const bh = h / scale;

    detections.push({
      classId: bestClass,
      className: CLASS_NAMES[bestClass] ?? `class_${bestClass}`,
      confidence: bestScore,
      x: Math.max(0, x / srcW),
      y: Math.max(0, y / srcH),
      w: Math.min(1, bw / srcW),
      h: Math.min(1, bh / srcH),
    });
  }

  return nms(detections, iouThreshold);
}
