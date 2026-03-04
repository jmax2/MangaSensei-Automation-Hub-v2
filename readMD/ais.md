# AI Providers

MangaSensei supports multiple AI providers to handle the linguistic analysis of manga pages. You can choose the provider that best fits your needs, budget, and privacy preferences.

## 1. Gemini (Default)
Google's Gemini models are the default and recommended choice. They offer excellent multimodal capabilities (vision + text) and are highly accurate for Japanese-to-English translation and linguistic breakdown.

- **Models Used:** `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`
- **Pros:** Fast, accurate, multimodal, generous free tier.
- **Cons:** Requires an internet connection and a Google API key.

## 2. Ollama (Local)
Ollama allows you to run large language models locally on your own machine. This is ideal for users who prioritize privacy or want to avoid API costs.

- **Models Used:** `llava` (Default vision model).
- **Pros:** 100% private, no API costs, works offline.
- **Cons:** Requires a powerful computer (especially GPU) for vision models, slower than cloud APIs, setup required.
- **Setup Instructions:**
  1. Download and install Ollama from [ollama.com](https://ollama.com).
  2. Open your terminal or command prompt.
  3. Run the command: `ollama run llava` to download and start the LLaVA vision model.
  4. Ensure Ollama is running in the background. By default, it runs a local server at `http://localhost:11434`.
  5. **Important:** If you are running MangaSensei in a browser, you may need to configure Ollama to accept Cross-Origin Resource Sharing (CORS) requests. You can do this by setting the environment variable `OLLAMA_ORIGINS="*"`.
     - On Mac/Linux: `OLLAMA_ORIGINS="*" ollama serve`
     - On Windows (Command Prompt): `set OLLAMA_ORIGINS="*" && ollama serve`

## 3. OpenRouter
OpenRouter is a unified API that gives you access to dozens of different AI models from various providers (OpenAI, Anthropic, Meta, etc.) through a single interface.

- **Models Used:** `anthropic/claude-3.5-sonnet` (Default fast vision model).
- **Pros:** Access to the best models in the world, easy to switch models, pay-as-you-go pricing.
- **Cons:** Requires an OpenRouter API key, costs money per request.
- **Setup Instructions:**
  1. Create an account at [openrouter.ai](https://openrouter.ai).
  2. Generate an API key in your account settings.
  3. Paste the API key into the "OpenRouter API Key" field in the MangaSensei Advanced Settings panel.

## 4. Advanced & Free Alternatives

### Ollama Cloud (No-Download "Bridge" Mode)
You can use massive models like `minimax-m2.5:cloud` or `qwen3.5:cloud` without downloading them. In this setup, your local Ollama instance stays active but offloads the heavy lifting to Ollama's high-speed cloud clusters.

**How it works:** You keep your Ollama Endpoint set to `http://localhost:11434`. When you request a model with the `:cloud` suffix, your local Ollama proxies the request automatically.

**Setup Instructions:**
1. **Authenticate:** Open your terminal and run `ollama signin`. This links your local machine to your Ollama Cloud account.
2. **Pull Metadata:** Run `ollama pull minimax-m2.5:cloud`. (This only takes a few seconds because it’s just fetching the configuration, not the huge model weights).
3. **Configure MangaSensei:**
   - **Ollama Endpoint:** `http://localhost:11434` (Do not change this to a remote URL).
   - **Ollama Model:** `minimax-m2.5:cloud`

- **Pros:** Runs huge 400B+ models on basic laptops; zero local storage used.
- **Cons:** Requires a stable internet connection; usage is subject to Ollama Cloud's tier limits.

### Hugging Face Inference API (Serverless 2026)
Hugging Face’s serverless API is a great "zero-cost" way to get high-quality vision analysis using the latest open-weight models like Gemma 3 or Phi-4.

- **Recommended Models:** `google/gemma-3-27b-it` or `microsoft/phi-4-vision-instruct`.
- **Implementation Snippet:**
```javascript
// Updated 2026 Serverless Fetch
async function queryHuggingFace(imageBase64) {
  const response = await fetch(
    "https://api-inference.huggingface.co/models/google/gemma-3-27b-it",
    {
      headers: { 
        "Authorization": `Bearer ${YOUR_HF_TOKEN}`,
        "Content-Type": "application/json"
      },
      method: "POST",
      body: JSON.stringify({ 
        inputs: imageBase64,
        parameters: { max_new_tokens: 500 }
      }),
    }
  );
  return await response.json();
}
```

### Essential Browser Security (CORS)
If you are running MangaSensei as a web app, the browser will block requests to your local Ollama unless you explicitly allow it.

Run this exact command to fix "Connection Refused" or "CORS" errors:
- **Mac/Linux:** `OLLAMA_ORIGINS="http://localhost:*,https://*" ollama serve`
- **Windows (PowerShell):** `$env:OLLAMA_ORIGINS="http://localhost:*,https://*"; ollama serve`

## 5. Local NLP & OCR (Fallback Methods)
If you prefer not to use AI, or if the AI providers fail, MangaSensei includes built-in fallback methods that run entirely in your browser.

- **Tesseract.js (OCR):** Extracts Japanese text from the manga images using Optical Character Recognition.
- **Kuromoji (NLP):** A JavaScript-based morphological analyzer for Japanese. It breaks down the extracted text into words, provides readings (furigana), and identifies the part of speech.
- **Pros:** 100% local, no setup required, extremely fast.
- **Cons:** Less accurate than AI (especially for handwritten or stylized manga fonts), cannot provide contextual translations or cultural explanations.

## Fallback Mechanism (Waterfall)
If your selected AI provider fails (e.g., due to a network error, rate limit, or timeout), MangaSensei will automatically fall back to the next available option in the "Waterfall" protocol:

1. Selected Provider (e.g., Ollama or OpenRouter)
2. Gemini (if different from selected)
3. Local OCR (Tesseract.js) + Text-only AI analysis
4. Local NLP (Kuromoji) - basic dictionary lookup without AI context.
