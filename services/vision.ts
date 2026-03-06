
import { BoundingBox } from "../types";

/**
 * Worker source code for OpenCV processing.
 * This code runs in a separate thread to keep the UI responsive.
 */
const visionWorkerCode = `
  let cvReady = false;
  
  // Load OpenCV from CDN inside the worker
  try {
    importScripts('https://docs.opencv.org/4.x/opencv.js');
  } catch (e) {
    console.error("Worker failed to load OpenCV script", e);
  }

  // Poll for OpenCV readiness
  function waitForCV() {
    if (self.cv && self.cv.Mat) {
      cvReady = true;
      self.postMessage({ type: 'ready' });
    } else {
      setTimeout(waitForCV, 100);
    }
  }
  waitForCV();

  self.onmessage = async (e) => {
    const { id, imageBase64, maxWidth } = e.data;
    if (!cvReady) {
      self.postMessage({ id, error: 'OpenCV not ready', bubbles: [] });
      return;
    }

    try {
      // Use fetch to get the blob and create an ImageBitmap for high-speed decoding in worker
      const response = await fetch('data:image/jpeg;base64,' + imageBase64);
      const blob = await response.blob();
      const img = await createImageBitmap(blob);

      let w = img.width;
      let h = img.height;
      
      // Downscale to save memory and CPU
      if (w > maxWidth || h > maxWidth) {
        const scale = maxWidth / Math.max(w, h);
        w *= scale;
        h *= scale;
      }

      // Use OffscreenCanvas for processing
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      img.close();

      const imageData = ctx.getImageData(0, 0, w, h);
      
      let src, gray, binary, contours, hierarchy;
      try {
        src = self.cv.matFromImageData(imageData);
        gray = new self.cv.Mat();
        binary = new self.cv.Mat();
        contours = new self.cv.MatVector();
        hierarchy = new self.cv.Mat();

        self.cv.cvtColor(src, gray, self.cv.COLOR_RGBA2GRAY, 0);
        self.cv.threshold(gray, binary, 210, 255, self.cv.THRESH_BINARY);
        self.cv.findContours(binary, contours, hierarchy, self.cv.RETR_EXTERNAL, self.cv.CHAIN_APPROX_SIMPLE);

        const bubbles = [];
        for (let i = 0; i < contours.size(); ++i) {
          const cnt = contours.get(i);
          const area = self.cv.contourArea(cnt);
          const rect = self.cv.boundingRect(cnt);
          
          if (area > (w * h * 0.003) && area < (w * h * 0.8)) {
            bubbles.push({
              ymin: (rect.y / h) * 100,
              xmin: (rect.x / w) * 100,
              ymax: ((rect.y + rect.height) / h) * 100,
              xmax: ((rect.x + rect.width) / w) * 100,
            });
          }
          cnt.delete();
        }

        // Spatial Bubble Grouping
        const mergedBubbles = [];
        for (const b of bubbles) {
          let merged = false;
          for (let m of mergedBubbles) {
            // Check if they overlap or are very close (within 5% of width/height)
            const dist = 5; 
            if (b.xmin - dist < m.xmax && b.xmax + dist > m.xmin &&
                b.ymin - dist < m.ymax && b.ymax + dist > m.ymin) {
              m.xmin = Math.min(m.xmin, b.xmin);
              m.ymin = Math.min(m.ymin, b.ymin);
              m.xmax = Math.max(m.xmax, b.xmax);
              m.ymax = Math.max(m.ymax, b.ymax);
              merged = true;
              break;
            }
          }
          if (!merged) mergedBubbles.push(b);
        }

        self.postMessage({ id, bubbles: mergedBubbles });
      } finally {
        if (src) src.delete();
        if (gray) gray.delete();
        if (binary) binary.delete();
        if (contours) contours.delete();
        if (hierarchy) hierarchy.delete();
      }
    } catch (err) {
      self.postMessage({ id, error: err.message, bubbles: [] });
    }
  };
`;

const blob = new Blob([visionWorkerCode], { type: 'application/javascript' });
const workerUrl = URL.createObjectURL(blob);

let visionWorker: Worker | null = null;
const pendingRequests = new Map<string, (bubbles: BoundingBox[]) => void>();

function ensureWorker(): Worker {
  if (visionWorker) return visionWorker;
  visionWorker = new Worker(workerUrl);
  visionWorker.onmessage = (e) => {
    const { id, bubbles, error } = e.data;
    if (pendingRequests.has(id)) {
      const resolve = pendingRequests.get(id)!;
      pendingRequests.delete(id);
      resolve(bubbles || []);
    }
  };
  return visionWorker;
}

/**
 * Offloads speech bubble detection to a dedicated Web Worker.
 */
export async function detectSpeechBubblesWorker(imageBase64: string, maxWidth: number = 640): Promise<BoundingBox[]> {
  const worker = ensureWorker();
  const id = Math.random().toString(36).substring(7);
  
  return new Promise((resolve) => {
    pendingRequests.set(id, resolve);
    worker.postMessage({ id, imageBase64, maxWidth });
  });
}
