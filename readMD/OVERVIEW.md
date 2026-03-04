# MangaSensei: Automation Hub — Technical Overview

MangaSensei is a high-performance "Command Center" designed to automate the linguistic analysis of manga. It transforms raw manga pages into interactive learning environments by combining advanced computer vision, LLM reasoning, and local OCR fallbacks.

## 🧠 The AI Analysis Waterfall

The core of the application is a robust, multi-tiered analysis pipeline (implemented in `services/gemini.ts`) designed to ensure successful data extraction even under heavy API load or safety triggers.

### 1. Pre-Screening (Efficiency Layer)
Before full analysis, the app uses **Gemini 3 Flash** to perform a rapid "density check." It counts dialogue bubbles and skips pages with low dialogue (action-heavy or scenery-only pages) to conserve tokens and reduce latency.

### 2. The Vision Waterfall
The hub attempts to extract data using models in the following order:
1.  **Gemini 3 Pro (Inference Tier):** The primary engine. Uses high-level reasoning to map dialogue to spatial coordinates (`boundingBox`) and provide deep grammatical context.
2.  **Gemini 3 Flash (Speed Tier):** Automatically triggered if Pro hits rate limits (429 errors).
3.  **Gemini 2.5 Pro (Stability Tier):** A fallback that utilizes a massive thinking budget for complex layouts.
4.  **Gemini 2.5 Flash (Legacy Tier):** Final multimodal attempt.

### 3. The Vision-Safe Fallback (OCR Layer)
If all vision models fail—often due to "Safety Filters" triggered by stylized manga art—the hub switches to a "Headless" text protocol:
*   **Local OCR:** Uses `Tesseract.js` to extract raw text strings directly in the browser.
*   **Text-Only Re-mapping:** Sends the raw text to Gemini (without the image) to be structured into the standard JSON schema, ensuring the user gets data even when the AI "cannot see" the page.

---

## 🕹️ Interface Architecture

The app is divided into three functional zones designed for a "Cyber-Noir" technical aesthetic:

### A. The Bridge (Control Center)
The left panel manages the input state.
*   **Targeting:** Users input source URLs and batch sizes.
*   **Provider Config:** Toggle between **Google Gemini**, **OpenRouter**, **Groq**, **DeepSeek**, and more.
*   **OpenRouter Resilience:** If the primary OpenRouter model fails (e.g., status 400), the system automatically attempts a fallback to `openrouter/auto` to ensure analysis continuity.
*   **Smart Cycle:** A specialized mode that automatically rotates between all configured providers based on the page index. This maximizes free-tier quotas and ensures high availability by automatically falling back to the next available provider if one encounters a rate limit.
*   **Smart Filtering:** Toggle the pre-screening logic on or off.

### B. The Terminal (Real-Time Monitor)
The center panel is a stylized visual console.
*   **Streaming Logs:** Every internal decision (model switches, successful extractions, retries) is logged with color-coded severity levels.
*   **Waterfall Visibility:** Users can see exactly which model "won" the extraction for each specific page.
*   **Progress Analytics:** Real-time tracking of note density and processing velocity.

### C. The Archive (Data Hub)
The right panel persists the results of finished chapters.
*   **Serialization:** Every chapter can be exported as raw **JSON** (for developers/external tools) or a formatted **Markdown Report** (for personal study).
*   **History Persistence:** Uses `localStorage` to keep recent batch results available between sessions.

---

## 📖 The Interactive Reader

Once processed, the reader provides a dense, interactive study layer:
*   **Spatial Tooltips:** Hovering over bubbles triggers tooltips mapped exactly to the art via SVG coordinate systems.
*   **Word Breakdown:** The "Word Focus" mode allows users to hover over specific Japanese terms for a deep-dive lexical analysis (Meaning, Romaji, and Part of Speech).
*   **Native TTS:** Uses Gemini's Native Audio capabilities to generate high-quality, natural Japanese speech for any extracted dialogue.
*   **Furigana Management:** Instant toggling of Furigana (`ruby` tags) to practice kanji recognition vs. reading.

---

## 🛠️ Technical Stack
- **Framework:** React 19 (Strict Mode)
- **Styling:** Tailwind CSS (Cyber-Noir palette: Slate-950, Indigo-600)
- **Icons:** Lucide-React
- **AI SDK:** `@google/genai` (utilizing Gemini 3 and 2.5 series)
- **Local Vision:** Tesseract.js
- **Persistence:** LocalStorage API

---

## 🛡️ System Resilience & Connection Loss

### What happens if the server connection is lost?
If you see the message `[vite] server connection lost. Polling for restart..`, it means the development server has temporarily disconnected. This often happens due to network instability or the environment resetting.

**During Analysis:**
-   **Execution State:** The analysis protocol runs entirely in your browser's memory. If the server disconnects but the browser tab remains open, the analysis **will continue** to run and make API calls.
-   **Re-execution:** If you try to "Execute Protocol" again while a previous execution is still running (even if the UI seems stuck due to connection loss), the system will guard against duplicate runs. However, if the browser tab was refreshed, the previous execution state is lost, and you can safely restart.
-   **Data Safety:** Extracted notes are committed to the internal state only after a page batch completes. If the connection loss leads to a full page refresh, unsaved progress for the *current* chapter being analyzed will be lost, but previously completed chapters (marked as 'Done') are persisted in the database.

**Recommendation:** If the connection is lost for more than a few seconds, wait for the "Reconnected" message. If the UI remains unresponsive, refresh the page. The Hub will re-load your chapters and optimized images from IndexedDB, allowing you to resume analysis from where you left off.
