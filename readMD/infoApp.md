
# MangaSensei v2.5.0 (2026 Edition)

MangaSensei is an advanced, AI-powered manga reading and linguistic analysis tool designed for language learners. It transforms static manga pages into interactive study materials by automatically detecting dialogue, translating it, and providing deep grammatical breakdowns.

## 🚄 Data Ingestion Protocols

### 1. Off-screen Worker Resizing
Raw manga pages often exceed 3000px in height, which creates massive memory pressure and slows down API inference. 
- **Mechanism:** When files are uploaded, they are passed to a **Dedicated Web Worker**.
- **Process:** The worker uses `createImageBitmap` and `OffscreenCanvas` to downscale images to a maximum width of **1200px** on a background thread.
- **Impact:** This prevents the Main UI thread from freezing during large imports and reduces API payload sizes by up to **80%**, drastically improving stability and speed.

### 2. IndexedDB Persistence Layer
Unlike traditional web apps that hold data in transient RAM, MangaSensei treats the browser as a local server.
- **Storage:** Optimized image Blobs are stored in **IndexedDB** (`MangaSenseiDB`).
- **Benefit:** You can index 50+ chapters (thousands of pages) without crashing the browser's memory. Results and images persist between refreshes, allowing long-running batch operations to survive session restarts.

## 🧠 The "Waterfall" Reasoning Engine

Extraction reliability is handled through a prioritized fallback system:

1.  **Prescreen (Gemini 3 Flash):** Rapidly scans for dialogue density. Pages with zero bubbles are skipped to optimize token usage.
2.  **Tier 1 (Gemini 3 Pro):** The primary extraction engine for high-accuracy spatial mapping and cultural nuance.
3.  **Tier 2 (Gemini 3 Flash):** Fast fallback if Pro hits rate limits (429 errors).
4.  **Tier 3 (Ollama Cloud / Hugging Face):** Zero-download cloud mode for massive models (Minimax, Qwen, Gemma 3).
5.  **Enhanced OCR Fallback (Tesseract.js + Text-AI):** 
    - When vision models are blocked by safety filters or rate limits, the system triggers a **spatial-aware OCR loop**.
    - **Spatial Mapping:** Instead of just extracting text, the app extracts the absolute pixel bounding boxes of every text paragraph using Tesseract.js.
    - **Normalization:** These coordinates are normalized to a 0-100 scale based on the source image dimensions.
    - **Contextual Correction:** The "dirty" OCR text and its spatial data are passed to a text-only Gemini model. The model is prompted to correct common OCR hallucinations (e.g., 'I' vs '!') and re-structure the notes while maintaining accurate UI placement via the provided coordinates.

## ⚡ Concurrency & Performance

### Async Batching
We process files in small, controlled batches (defaulting to 5 files at a time). This yields control back to the browser's event loop, ensuring the "Execute Protocol" button and terminal logs remain responsive even while heavy computation is happening in the background.

### Parallel Analysis
The hub supports a **Concurrency Level of 2** for API calls. This allows the system to analyze two pages simultaneously, doubling throughput while staying within the rate limits of standard API tiers.

## 🚧 Current Challenges & Roadmap

### Known Limitations
- **CPU Spikes:** The initialization of the resizing worker is CPU-intensive. Users on low-end mobile devices might notice temporary thermal throttling during massive 1000+ page imports.
- **IndexedDB Quotas:** While persistent, storage is limited by the browser's disk quota (usually ~10-20% of free disk space).

### Future Optimization
- **Bubble Geometry Logic:** Integrating lightweight blob detection to isolate speech bubbles before OCR, further reducing noise from manga screentone.
- **AnkiConnect Integration:** Direct background syncing of extracted vocabulary to local Anki decks.
- **Delta Analysis:** Only analyzing "unknown" words by comparing results against a user's master vocabulary list.
