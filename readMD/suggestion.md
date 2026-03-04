
# Heuristic Stability & Performance Optimizations

MangaSensei is designed for high-throughput extraction. We've implemented several advanced optimizations to ensure the application remains responsive even under extreme load.

## ✅ Implemented Stability Fixes

### 1. Spatial Downscaling for CV
OpenCV's contour detection does not require high resolution.
- **Optimization:** Image data is downscaled to a **maximum dimension of 640px** before vision analysis.
- **Impact:** Drastically lowers memory usage and prevents OOM (Out of Memory) crashes.

### 2. Manual Memory Garbage Collection (OpenCV)
- **Problem:** OpenCV.js memory (cv.Mat) is not tracked by the JS GC.
- **Fix:** Strict `try...finally` blocks ensure every `cv.Mat` is manually deleted.

### 3. Dedicated Vision Worker (New! 🚀)
- **Optimization:** Offloaded the heavy `cv.findContours` and `cv.threshold` calculations to a dedicated **Web Worker**.
- **Impact:** The main UI thread is completely free during the vision heuristic phase, ensuring smooth animations and responsive buttons while batch processing occurs in the background.

### 4. Canvas Pooling (New! 🚀)
- **Optimization:** Implemented a singleton `CanvasPool` that caches and reuses `HTMLCanvasElement` objects.
- **Impact:** Significantly reduces GC pressure and object allocation overhead, which is critical during massive chapter imports (1000+ images).

## 🚀 Recommended Future Improvements

### A. Progressive Loading for Webtoon Mode
Currently, Webtoon mode attempts to render many high-res images at once. Implementing an IntersectionObserver-based lazy loader would further reduce initial render time and memory footprint.

### B. Adaptive Vision Thresholding
Standard binary thresholding can struggle with dense screentones. Moving to `cv.adaptiveThreshold` in the worker would improve accuracy, though with a slightly higher compute cost.

### C. Client-Side PDF Generation
Allowing users to export their analyzed chapters as PDFs (including the translated overlay) would make the tool even more useful for offline study.

### D. DeepSeek-V3 Support
Integrate DeepSeek's latest vision models for even faster, lower-cost analysis, potentially replacing some mid-tier Gemini fallbacks.

### E. Local LLM Fine-tuning
Tools to fine-tune small local models (like Phi-4 or Gemma 3) on specific manga genres (Shonen, Seinen, etc.) for better slang detection and genre-specific vocabulary.

### F. Hugging Face Space Deployment
One-click deployment of a private MangaSensei instance with dedicated GPU resources using Hugging Face Spaces.
