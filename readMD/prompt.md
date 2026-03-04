# Prompt: MangaSensei Automation Hub

Act as a world-class senior frontend engineer with deep expertise in the Gemini API and UI/UX design. Create a high-performance React web application using Tailwind CSS for the **MangaSensei Automation Hub**.

## 🎯 Vision
This app is a "Command Center" for the automated analysis protocols previously handled via headless scripts. It allows users to input manga chapter URLs, configure analysis parameters, and monitor the AI's "waterfall" reasoning process in real-time through a visual terminal and dashboard.

## 🛠️ Core Functionality

### 1. Automation Dashboard (The "Bridge")
- **Input Controls**: 
  - A field for the "Starting Chapter URL".
  - A "Batch Count" slider/input (number of chapters to crawl).
  - A "Target Language" dropdown.
  - A "Smart Filter" toggle (to skip pages with low dialogue).
- **Primary Action**: A prominent "Execute Protocol" button that initiates the crawl-download-analyze loop.

### 2. Real-Time Monitor (The "Terminal")
- **Visual Console**: A scrollable, stylized terminal window that outputs "console-style" logs from the automation engine.
  - Success messages in Emerald.
  - Warnings/Retries in Amber.
  - Model switches (Waterfall) in Purple.
  - System errors in Rose.
- **Progress Visualization**: A global progress bar for the batch, and individual circular progress indicators for the current page being processed.

### 3. Analysis Waterfall Logic
Implement a robust analysis pipeline similar to the following:
- **Prescreen**: Gemini 2.5 Flash detects bubble count.
- **Main Engine**: Attempts analysis via **Gemini 3 Pro**.
- **Waterfall Fallbacks**: Automatically cycles through **Gemini 3 Flash**, **Gemini 2.5 Pro**, and **Gemini 2.5 Flash** if quotas are hit or errors occur.
- **Safety Fallback**: Local OCR (Tesseract.js) + Text-only Gemini analysis if vision filters trigger.

### 4. Advanced Settings (Provider Config)
A dedicated settings panel (similar to the original app) supporting:
- **Gemini API**: Default provider using `process.env.API_KEY`.
- **OpenRouter**: Support for models like Claude 3.5 Sonnet.
- **Ollama**: Support for local multimodal models (localhost).

### 5. Results & History
- A side panel or gallery view showing processed chapters.
- One-click "Export JSON" or "Download Markdown Report" for each completed chapter.

## 🎨 Design System
- **Theme**: Ultra-dark "Cyber-Noir" (Slate 950 base).
- **Palette**: Indigo (Primary), Emerald (Success), Amber (Warning/Retry), Purple (AI Reasoning).
- **UI Components**: 
  - Glassmorphism for cards.
  - Monospace font for the log window.
  - High-end transitions and subtle "scanning" animations for active pages.

## 🧬 Technical Requirements
- Use `GoogleGenAI` from `@google/genai`.
- Support `responseSchema` for structured JSON output.
- Implement exponential backoff for 429 errors.
- Ensure the UI is responsive and provides clear feedback for long-running batch operations.

---

## 🚀 Possible Suggestions for Evolution

1.  **Direct Anki Integration**: Add an "AnkiConnect" toggle that automatically pushes new vocabulary found during automation to a specified Anki deck.
2.  **Visual Delta Mode**: A feature that highlights *only* the new words found in a chapter compared to the user's previously analyzed "Mastered" list.
3.  **Image Upscaling Layer**: Automatically upscale small or blurry manga panels using a pre-process step to improve OCR/Vision accuracy before sending to Gemini.
4.  **Audio Narrative Generation**: A post-process feature that uses Gemini TTS to generate a full "Audio Drama" version of the analyzed chapter, using the identified speakers.
5.  **Multi-Tab Concurrent Analysis**: Allow the hub to open multiple "workers" to process different chapters in parallel if the user's API tier supports higher RPM (Requests Per Minute).
