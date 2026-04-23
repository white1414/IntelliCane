import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-cpu";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import * as tflite from "@tensorflow/tfjs-tflite";
import { CLASS_NAMES } from "./labels";

const INPUT_SIZE = 640;
const NUM_CLASSES = CLASS_NAMES.length;

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

let model: tflite.TFLiteModel | null = null;
let loading: Promise<tflite.TFLiteModel> | null = null;

export async function loadModel(modelUrl: string): Promise<tflite.TFLiteModel> {
  if (model) return model;
  if (loading) return loading;

  // Serve WASM from the bundled /tflite-wasm folder so it works on the
  // ESP32-CAM SoftAP (no internet) once the APK is installed.
  const base = import.meta.env.BASE_URL.replace(/\/$/, "") + "/tflite-wasm/";
  setWasmPaths(base);
  tflite.setWasmPath(base);
  await tf.ready();

  loading = tflite
    .loadTFLiteModel(modelUrl, { numThreads: Math.min(4, navigator.hardwareConcurrency || 2) })
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
): { tensor: tf.Tensor; scale: number; padX: number; padY: number; srcW: number; srcH: number } {
  const srcW =
    (source as HTMLVideoElement).videoWidth ||
    (source as HTMLImageElement).naturalWidth ||
    (source as HTMLCanvasElement).width;
  const srcH =
    (source as HTMLVideoElement).videoHeight ||
    (source as HTMLImageElement).naturalHeight ||
    (source as HTMLCanvasElement).height;

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

  // Build [1, H, W, 3] float32 in 0..1 — matches the standard ultralytics
  // TFLite export (NHWC). For INT8 models the runtime will quantize on entry.
  const imgData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  const data = new Float32Array(INPUT_SIZE * INPUT_SIZE * 3);
  for (let i = 0, j = 0; i < imgData.length; i += 4, j += 3) {
    data[j] = imgData[i] / 255;
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
  const confThreshold = options?.confThreshold ?? 0.4;
  const iouThreshold = options?.iouThreshold ?? 0.45;

  const { tensor, scale, padX, padY, srcW, srcH } = preprocess(
    source,
    scratchCanvas,
  );

  let outputs: tf.Tensor | tf.Tensor[] | { [n: string]: tf.Tensor };
  try {
    outputs = model.predict(tensor) as tf.Tensor | tf.Tensor[];
  } finally {
    tensor.dispose();
  }

  // Pull the first output tensor.
  let out: tf.Tensor;
  if (Array.isArray(outputs)) {
    out = outputs[0];
  } else if (outputs instanceof tf.Tensor) {
    out = outputs;
  } else {
    out = Object.values(outputs)[0] as tf.Tensor;
  }

  // Ultralytics TFLite YOLOv8 output shape can be [1, 4+nc, 8400] OR
  // [1, 8400, 4+nc] depending on export options. Detect by dim values.
  const dims = out.shape;
  const data = (await out.data()) as Float32Array;
  out.dispose();
  if (Array.isArray(outputs)) {
    for (let i = 1; i < outputs.length; i++) (outputs as tf.Tensor[])[i].dispose();
  }

  const expectedAttrs = 4 + NUM_CLASSES;
  let numAnchors: number;
  let attrIsFastAxis: boolean; // true → [1, A, 4+nc]; false → [1, 4+nc, A]
  if (dims[1] === expectedAttrs) {
    numAnchors = dims[2]!;
    attrIsFastAxis = false;
  } else if (dims[2] === expectedAttrs) {
    numAnchors = dims[1]!;
    attrIsFastAxis = true;
  } else {
    throw new Error(
      `Unexpected model output shape [${dims.join(",")}]; expected one dim to equal ${expectedAttrs}`,
    );
  }

  const get = (anchor: number, attr: number): number =>
    attrIsFastAxis
      ? data[anchor * expectedAttrs + attr]
      : data[attr * numAnchors + anchor];

  // Some TFLite exports keep the model input range at 0..640, others at 0..1.
  // Sniff once: if max coord is <=1.5 we assume normalized coords.
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
    for (let c = 0; c < NUM_CLASSES; c++) {
      const score = get(i, 4 + c);
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (bestScore < confThreshold) continue;

    const cx = get(i, 0) * coordScale;
    const cy = get(i, 1) * coordScale;
    const w = get(i, 2) * coordScale;
    const h = get(i, 3) * coordScale;

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
