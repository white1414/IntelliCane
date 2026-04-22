import * as ort from "onnxruntime-web";
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

let session: ort.InferenceSession | null = null;
let loading: Promise<ort.InferenceSession> | null = null;

export async function loadModel(modelUrl: string): Promise<ort.InferenceSession> {
  if (session) return session;
  if (loading) return loading;

  ort.env.wasm.wasmPaths =
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
  ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
  ort.env.wasm.simd = true;

  loading = ort.InferenceSession.create(modelUrl, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  }).then((s) => {
    session = s;
    return s;
  });
  return loading;
}

export function isModelLoaded(): boolean {
  return session !== null;
}

// Resize+letterbox the source frame into a 640x640 RGB Float32Array (CHW, 0..1).
function preprocess(
  source: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
  scratchCanvas: HTMLCanvasElement,
): { tensor: Float32Array; scale: number; padX: number; padY: number; srcW: number; srcH: number } {
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

  const imgData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  const tensor = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const channelSize = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < channelSize; i++) {
    tensor[i] = imgData[i * 4] / 255;
    tensor[i + channelSize] = imgData[i * 4 + 1] / 255;
    tensor[i + 2 * channelSize] = imgData[i * 4 + 2] / 255;
  }
  return { tensor, scale, padX, padY, srcW, srcH };
}

function iou(a: Detection, b: Detection): number {
  const ax1 = a.x;
  const ay1 = a.y;
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx1 = b.x;
  const by1 = b.y;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const interX1 = Math.max(ax1, bx1);
  const interY1 = Math.max(ay1, by1);
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
  if (!session) throw new Error("Model not loaded yet");
  const confThreshold = options?.confThreshold ?? 0.4;
  const iouThreshold = options?.iouThreshold ?? 0.45;

  const { tensor, scale, padX, padY, srcW, srcH } = preprocess(
    source,
    scratchCanvas,
  );
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const inputTensor = new ort.Tensor("float32", tensor, [
    1,
    3,
    INPUT_SIZE,
    INPUT_SIZE,
  ]);

  const results = await session.run({ [inputName]: inputTensor });
  const output = results[outputName];
  // Ultralytics YOLOv8 ONNX output: [1, 4 + nc, 8400]
  const data = output.data as Float32Array;
  const dims = output.dims;
  const numAttrs = dims[1]; // 4 + nc
  const numAnchors = dims[2]; // 8400

  const detections: Detection[] = [];
  for (let i = 0; i < numAnchors; i++) {
    let bestClass = -1;
    let bestScore = 0;
    for (let c = 0; c < NUM_CLASSES; c++) {
      const score = data[(4 + c) * numAnchors + i];
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (bestScore < confThreshold) continue;

    // YOLOv8 outputs xywh in input pixel space (0..640)
    const cx = data[0 * numAnchors + i];
    const cy = data[1 * numAnchors + i];
    const w = data[2 * numAnchors + i];
    const h = data[3 * numAnchors + i];

    // Undo letterbox: subtract pad, divide by scale, then normalize
    const x = (cx - w / 2 - padX) / scale;
    const y = (cy - h / 2 - padY) / scale;
    const bw = w / scale;
    const bh = h / scale;

    detections.push({
      classId: bestClass,
      className: CLASS_NAMES[bestClass],
      confidence: bestScore,
      x: Math.max(0, x / srcW),
      y: Math.max(0, y / srcH),
      w: Math.min(1, bw / srcW),
      h: Math.min(1, bh / srcH),
    });
  }

  return nms(detections, iouThreshold);
}
