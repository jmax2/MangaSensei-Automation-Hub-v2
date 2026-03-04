
import { GoogleGenAI, Type, GenerateContentResponse, Modality } from "@google/genai";
import { StudyNote, WordBreakdown, BoundingBox, PreScreenMode, AIProvider, MasteryLevel } from "../types";
// @ts-ignore
import Tesseract from "tesseract.js";
// @ts-ignore
import * as wanakana from "wanakana";
// @ts-ignore
import kuromoji from "kuromoji";
import { canvasPool } from "./canvasPool";
import { detectSpeechBubblesWorker } from "./vision";

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    notes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          originalText: { type: Type.STRING, description: "The original text from the manga bubble." },
          speaker: { type: Type.STRING, description: "The name or role of the character speaking (e.g. 'Character A', 'Narrator', 'Protagonist'). Be consistent across bubbles." },
          explanation: { type: Type.STRING, description: "Grammar or cultural context explaining the language nuances." },
          type: { 
            type: Type.STRING, 
            enum: ['vocabulary', 'grammar', 'culture', 'translation']
          },
          boundingBox: {
            type: Type.OBJECT,
            properties: {
              ymin: { type: Type.NUMBER, description: "Top coordinate as percentage (0-100)" },
              xmin: { type: Type.NUMBER, description: "Left coordinate as percentage (0-100)" },
              ymax: { type: Type.NUMBER, description: "Bottom coordinate as percentage (0-100)" },
              xmax: { type: Type.NUMBER, description: "Right coordinate as percentage (0-100)" }
            },
            required: ["ymin", "xmin", "ymax", "xmax"]
          },
          translations: {
            type: Type.OBJECT,
            description: "A map where keys are language names (e.g., 'Japanese', 'Spanish').",
            properties: {
              Japanese: {
                type: Type.OBJECT,
                properties: {
                  text: { type: Type.STRING, description: "Translation into natural Japanese. Use HTML ruby tags for furigana (e.g. <ruby>漢字<rt>かんじ</rt></ruby>)." },
                  reading: { type: Type.STRING, description: "Full sentence transcription in Romaji (alphabetical)." },
                  breakdown: {
                    type: Type.ARRAY,
                    description: "Word-by-word breakdown of the Japanese text.",
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        japanese: { type: Type.STRING },
                        romaji: { type: Type.STRING },
                        meaning: { type: Type.STRING },
                        notes: { type: Type.STRING },
                        partOfSpeech: {
                          type: Type.STRING,
                          enum: ['verb', 'noun', 'adjective', 'adverb', 'particle', 'conjunction', 'interjection', 'unknown'],
                          description: "The grammatical role of the word."
                        }
                      },
                      required: ["japanese", "romaji", "meaning", "notes", "partOfSpeech"]
                    }
                  }
                },
                required: ["text", "reading", "breakdown"]
              }
            },
            additionalProperties: {
              type: Type.OBJECT,
              properties: {
                text: { type: Type.STRING },
                reading: { type: Type.STRING }
              },
              required: ["text"]
            }
          }
        },
        required: ["originalText", "explanation", "type", "boundingBox", "translations"]
      }
    }
  },
  required: ["notes"]
};

/**
 * Singleton for Kuromoji Tokenizer.
 */
let tokenizerInstance: any = null;
async function getTokenizer(): Promise<any> {
  if (tokenizerInstance) return tokenizerInstance;
  return new Promise((resolve) => {
    kuromoji.builder({ dicPath: "https://takuyaa.github.io/kuromoji.js/demo/kuromoji/dict/" }).build((err: any, tokenizer: any) => {
      if (err) {
        console.error("Kuromoji dictionary load failed:", err);
        // Return a mock tokenizer that just returns the input as a single token
        const mockTokenizer = {
          tokenize: (text: string) => [{
            surface_form: text,
            pos: 'unknown',
            reading: '',
            basic_form: text
          }]
        };
        tokenizerInstance = mockTokenizer;
        resolve(mockTokenizer);
      } else {
        tokenizerInstance = tokenizer;
        resolve(tokenizer);
      }
    });
  });
}

function mapPOS(pos: string): 'verb' | 'noun' | 'adjective' | 'adverb' | 'particle' | 'conjunction' | 'interjection' | 'unknown' {
  const posMap: Record<string, any> = {
    '名詞': 'noun',
    '動詞': 'verb',
    '形容詞': 'adjective',
    '副詞': 'adverb',
    '助詞': 'particle',
    '接続詞': 'conjunction',
    '感動詞': 'interjection'
  };
  return posMap[pos] || 'unknown';
}

async function localNLPAnalysis(ocrText: string, targetLanguage: string): Promise<StudyNote> {
  const tokenizer = await getTokenizer();
  const tokens = tokenizer.tokenize(ocrText);

  const breakdown: WordBreakdown[] = tokens.map((token: any) => {
    return {
      japanese: token.surface_form,
      romaji: wanakana.toRomaji(token.surface_form),
      meaning: "[Manual lookup required]",
      notes: `Local JS fallback of ${token.basic_form || token.surface_form}`,
      partOfSpeech: mapPOS(token.pos)
    };
  });

  const rubyText = tokens.map((token: any) => {
    const hiragana = wanakana.toHiragana(token.reading || "");
    if (token.reading && token.surface_form !== hiragana && !/^\d+$/.test(token.surface_form)) {
      return `<ruby>${token.surface_form}<rt>${hiragana}</rt></ruby>`;
    }
    return token.surface_form;
  }).join("");

  return {
    id: `local-nlp-${Date.now()}`,
    pageIndex: 0,
    originalText: ocrText,
    speaker: "Unknown",
    explanation: "Performed using local Kuromoji NLP engine after AI timeouts.",
    type: "translation",
    targetLanguage,
    boundingBox: { ymin: 45, xmin: 45, ymax: 55, xmax: 55 },
    translations: {
      Japanese: {
        text: rubyText,
        reading: wanakana.toRomaji(ocrText),
        breakdown
      }
    }
  };
}

async function extractTextWithOCR(imageBase64: string): Promise<string[]> {
  try {
    const imageUrl = `data:image/jpeg;base64,${imageBase64}`;
    const result = await Tesseract.recognize(imageUrl, 'jpn+eng');
    return ((result.data as any).paragraphs || [])
      .map((p: any) => p.text.trim())
      .filter((t: string) => t.length > 1);
  } catch (err) {
    return [];
  }
}

export async function preScreenPage(imageBase64: string, mode: PreScreenMode = 'ai_vision'): Promise<{ dialogueBubbleCount: number }> {
  if (mode === 'none') return { dialogueBubbleCount: 1 };

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  if (mode === 'ocr_lite') {
    try {
      const ocrBlocks = await extractTextWithOCR(imageBase64);
      if (ocrBlocks.length === 0) return { dialogueBubbleCount: 0 };

      const prompt = `The following text segments were extracted from a manga page via OCR. Estimate how many distinct dialogue bubbles they represent. Return only JSON: { "dialogueBubbleCount": number }.\nSegments:\n${ocrBlocks.join('\n')}`;

      const response = await ai.models.generateContent({
        model: "gemini-flash-lite-latest",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              dialogueBubbleCount: { type: Type.NUMBER }
            },
            required: ["dialogueBubbleCount"]
          }
        }
      });
      return JSON.parse(response.text || '{"dialogueBubbleCount": 0}');
    } catch (err) {
      console.warn("OCR + Lite pre-screening failed, falling back to simple count...", err);
      const ocrBlocks = await extractTextWithOCR(imageBase64);
      return { dialogueBubbleCount: Math.max(1, Math.ceil(ocrBlocks.length / 2)) };
    }
  }

  // Default: ai_vision
  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [
          { text: "Analyze this manga page. Count only the primary speech bubbles that contain dialogue. Return only JSON: { \"dialogueBubbleCount\": number }." },
          { inlineData: { mimeType: "image/jpeg", data: imageBase64 } }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            dialogueBubbleCount: { type: Type.NUMBER, description: "The count of speech bubbles containing dialogue." }
          },
          required: ["dialogueBubbleCount"]
        }
      }
    });

    const text = response.text || '{"dialogueBubbleCount": 0}';
    return JSON.parse(text);
  } catch (error) {
    console.warn("Gemini pre-screening failed, attempting off-thread vision worker...", error);
    try {
      // Offload vision processing to a Web Worker to avoid freezing the main UI thread
      const bubbles = await detectSpeechBubblesWorker(imageBase64);
      if (bubbles.length > 0) return { dialogueBubbleCount: bubbles.length };
      
      const ocrBlocks = await extractTextWithOCR(imageBase64);
      if (ocrBlocks.length > 0) {
        return { dialogueBubbleCount: Math.max(1, Math.ceil(ocrBlocks.length / 2)) };
      }
      return { dialogueBubbleCount: 0 }; 
    } catch (fallbackError) {
      console.error("Vision worker pre-screening failed entirely.", fallbackError);
      return { dialogueBubbleCount: 5 }; // Conservative default
    }
  }
}

function normalizeBoundingBox(box: any) {
  if (!box) return undefined;
  const coords = [box.ymin, box.xmin, box.ymax, box.xmax];
  const maxVal = Math.max(...coords);
  let divisor = 1;
  if (maxVal > 1000) divisor = maxVal / 100;
  else if (maxVal > 100) divisor = 10;
  else divisor = 1;

  return {
    ymin: Math.max(0, Math.min(100, box.ymin / divisor)),
    xmin: Math.max(0, Math.min(100, box.xmin / divisor)),
    ymax: Math.max(0, Math.min(100, box.ymax / divisor)),
    xmax: Math.max(0, Math.min(100, box.xmax / divisor)),
  };
}

function getPromptForMasteryLevel(masteryLevel: MasteryLevel, targetLanguage: string): string {
  const basePrompt = `Analyze this manga page for language study. Extract text, speakers, and explanations. Detect exact bounding boxes for each speech bubble using 0-100 normalized coordinates. Translate to natural Japanese with HTML ruby tags for furigana and also to ${targetLanguage}. Provide a word-by-word breakdown for the Japanese translation including Part of Speech. Return JSON.`;
  
  if (masteryLevel === 'beginner') {
    return `${basePrompt} Focus on basic grammar, provide furigana for all kanji, and explain simple concepts clearly.`;
  } else if (masteryLevel === 'intermediate') {
    return `${basePrompt} Focus on intermediate grammar points, nuances, and provide furigana only for less common kanji.`;
  } else if (masteryLevel === 'advanced') {
    return `${basePrompt} Focus on advanced vocabulary, slang, cultural context, and native-level nuances. Omit furigana for common kanji.`;
  }
  return basePrompt;
}

async function attemptAnalysis(model: string, imageBase64: string, targetLanguage: string, masteryLevel: MasteryLevel = 'beginner'): Promise<StudyNote[]> {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const isPro = model.includes('pro');
  
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: model,
    contents: {
      parts: [
        { text: getPromptForMasteryLevel(masteryLevel, targetLanguage) },
        { inlineData: { mimeType: "image/jpeg", data: imageBase64 } }
      ]
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: responseSchema,
      thinkingConfig: isPro ? { thinkingBudget: 4000 } : undefined
    }
  });

  const parsed = JSON.parse(response.text || '{"notes": []}');
  const rawNotes = parsed.notes || [];
  
  return rawNotes.map((note: any) => ({
    ...note,
    boundingBox: normalizeBoundingBox(note.boundingBox)
  }));
}

async function attemptOllama(imageBase64: string, targetLanguage: string, masteryLevel: MasteryLevel, ollamaModel: string = 'llava', ollamaEndpoint: string = 'http://localhost:11434'): Promise<StudyNote[]> {
  const prompt = getPromptForMasteryLevel(masteryLevel, targetLanguage);
  
  // Ensure endpoint doesn't end with a slash and append /api/generate
  const baseUrl = ollamaEndpoint.replace(/\/$/, '');
  const url = `${baseUrl}/api/generate`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      prompt: prompt,
      images: [imageBase64],
      stream: false,
      format: 'json'
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama failed with status: ${response.status}`);
  }

  const data = await response.json();
  const parsed = JSON.parse(data.response || '{"notes": []}');
  const rawNotes = parsed.notes || [];
  
  return rawNotes.map((note: any) => ({
    ...note,
    boundingBox: normalizeBoundingBox(note.boundingBox)
  }));
}

async function attemptOpenRouter(imageBase64: string, targetLanguage: string, masteryLevel: MasteryLevel, model: string = 'google/gemma-3-4b-it:free', apiKey?: string): Promise<StudyNote[]> {
  const prompt = getPromptForMasteryLevel(masteryLevel, targetLanguage);
  const finalApiKey = apiKey || import.meta.env.VITE_OPENROUTER_API_KEY || localStorage.getItem('openrouter_api_key');
  
  if (!finalApiKey) {
    throw new Error("OpenRouter API key not found. Please set it in settings or environment.");
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${finalApiKey}`,
      'HTTP-Referer': window.location.origin,
      'X-Title': 'MangaSensei'
    },
    body: JSON.stringify({
      model: model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter failed with status: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '{"notes": []}';
  const parsed = JSON.parse(content);
  const rawNotes = parsed.notes || [];
  
  return rawNotes.map((note: any) => ({
    ...note,
    boundingBox: normalizeBoundingBox(note.boundingBox)
  }));
}

async function attemptGenericOpenAI(
  imageBase64: string, 
  targetLanguage: string, 
  masteryLevel: MasteryLevel, 
  endpoint: string, 
  apiKey: string, 
  model: string
): Promise<StudyNote[]> {
  const prompt = getPromptForMasteryLevel(masteryLevel, targetLanguage);
  
  if (!apiKey) {
    throw new Error("API key not found for this provider.");
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Provider failed (${response.status}): ${err.error?.message || response.statusText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '{"notes": []}';
  const parsed = JSON.parse(content);
  const rawNotes = parsed.notes || [];
  
  return rawNotes.map((note: any) => ({
    ...note,
    boundingBox: normalizeBoundingBox(note.boundingBox)
  }));
}

async function attemptHuggingFace(imageBase64: string, targetLanguage: string, masteryLevel: MasteryLevel, hfApiKey: string, hfModel: string): Promise<StudyNote[]> {
  const prompt = getPromptForMasteryLevel(masteryLevel, targetLanguage);
  
  if (!hfApiKey) {
    throw new Error("Hugging Face API key not found. Please set it in settings.");
  }

  const response = await fetch(
    `https://api-inference.huggingface.co/models/${hfModel}`,
    {
      headers: { 
        "Authorization": `Bearer ${hfApiKey}`,
        "Content-Type": "application/json"
      },
      method: "POST",
      body: JSON.stringify({ 
        inputs: imageBase64,
        parameters: { 
          max_new_tokens: 1000,
          // Some models need specific parameters for vision
        }
      }),
    }
  );

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(`Hugging Face failed (${response.status}): ${errData.error || response.statusText}`);
  }

  const data = await response.json();
  let content = '';
  
  // Handle different HF response formats
  if (Array.isArray(data)) {
    content = data[0]?.generated_text || '';
  } else if (data.generated_text) {
    content = data.generated_text;
  } else if (typeof data === 'string') {
    content = data;
  } else {
    content = JSON.stringify(data);
  }

  // Extract JSON block if present
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : content;
  
  try {
    const parsed = JSON.parse(jsonStr);
    const rawNotes = parsed.notes || [];
    return rawNotes.map((note: any) => ({
      ...note,
      boundingBox: normalizeBoundingBox(note.boundingBox)
    }));
  } catch (e) {
    console.error("Failed to parse Hugging Face JSON response:", content);
    throw new Error("Hugging Face returned an invalid JSON format.");
  }
}

async function analyzeTextOnly(
  ocrSegments: { text: string; bbox: { ymin: number; xmin: number; ymax: number; xmax: number } }[], 
  pageIndex: number, 
  targetLanguage: string
): Promise<StudyNote[]> {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const segmentsString = ocrSegments
    .map((s, i) => `Segment ${i+1}: "${s.text}" [BBox: ymin:${s.bbox.ymin}, xmin:${s.bbox.xmin}, ymax:${s.bbox.ymax}, xmax:${s.bbox.xmax}]`)
    .join('\n');

  const prompt = `The following text segments were extracted from a manga page via local OCR. Correction required. Group segments into bubbles. Identify speaker, Japanese translation (with <ruby>), and ${targetLanguage}. Word breakdown needed. Return JSON.\nOCR:\n${segmentsString}`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-flash-lite-latest", 
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema
      }
    });

    const parsed = JSON.parse(response.text || '{"notes": []}');
    return (parsed.notes || []).map((note: any, index: number) => ({
      ...note,
      id: `text-ai-${pageIndex}-${index}`,
      pageIndex: pageIndex,
      targetLanguage: targetLanguage,
      boundingBox: normalizeBoundingBox(note.boundingBox)
    }));
  } catch (err) {
    throw err;
  }
}

async function performLocalOCRAnalysis(
  imageBase64: string, 
  pageIndex: number, 
  targetLanguage: string, 
  forceLocalNLP: boolean = false,
  onModelSwitch?: (modelName: string) => void
): Promise<StudyNote[]> {
  const imageUrl = `data:image/jpeg;base64,${imageBase64}`;
  const imgSize = await new Promise<{w: number, h: number}>((resolve) => {
    const i = new Image();
    i.onload = () => resolve({ w: i.width, h: i.height });
    i.onerror = () => resolve({ w: 1000, h: 1000 });
    i.src = imageUrl;
  });

  const result = await Tesseract.recognize(imageUrl, 'jpn+eng');
  const { paragraphs } = result.data as any;
  if (!paragraphs || paragraphs.length === 0) throw new Error("No usable text found by OCR.");
  
  const ocrSegments = paragraphs.map((p: any) => ({
    text: p.text.trim(),
    bbox: {
      ymin: (p.bbox.y0 / imgSize.h) * 100,
      xmin: (p.bbox.x0 / imgSize.w) * 100,
      ymax: (p.bbox.y1 / imgSize.h) * 100,
      xmax: (p.bbox.x1 / imgSize.w) * 100,
    }
  })).filter((s: any) => s.text.length > 1);

  if (ocrSegments.length > 0) {
    if (!forceLocalNLP) {
      try {
        if (onModelSwitch) onModelSwitch("OCR Fallback (Tesseract + Text-AI)");
        return await analyzeTextOnly(ocrSegments, pageIndex, targetLanguage);
      } catch (aiErr) {
        console.warn("Text-AI analysis failed, falling back to local NLP...");
      }
    }
    
    if (onModelSwitch) onModelSwitch("Local NLP (Kuromoji)");
    const results: StudyNote[] = [];
    for (const [idx, seg] of ocrSegments.entries()) {
       const note = await localNLPAnalysis(seg.text, targetLanguage);
       note.id = `local-nlp-${pageIndex}-${idx}`;
       note.pageIndex = pageIndex;
       note.boundingBox = seg.bbox;
       results.push(note);
    }
    return results;
  }
  throw new Error("No segments found after OCR.");
}

export async function waterfallAnalysis(
  imageBase64: string, 
  pageIndex: number, 
  targetLanguage: string,
  masteryLevel: MasteryLevel = 'beginner',
  aiProvider: AIProvider = 'gemini',
  ollamaModel: string = 'llava',
  ollamaEndpoint: string = 'http://localhost:11434',
  hfApiKey: string = '',
  hfModel: string = 'google/gemma-3-27b-it',
  onModelSwitch?: (modelName: string) => void,
  providerConfig?: any
): Promise<StudyNote[]> {
  const geminiModels = ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'];

  // Define the order of providers for Smart Cycle
  // We prioritize providers that are likely to have free tiers or high quotas
  const smartCycleOrder: AIProvider[] = [
    'groq',         // Extremely fast, generous free tier
    'openrouter',   // Access to many free models (Gemma 3 4B)
    'cerebras',     // Fast, free developer tier
    'siliconflow',  // Large sign-up bonus/free models
    'deepseek',     // Cheap/Free tiers
    'sambanova',    // Daily reset limits
    'wisdomgate',   // Daily credits
    'huggingface',  // Free inference API
    'local_nlp',    // Truly free, no API needed
    'gemini'        // Reliable fallback
  ];

  const getProviderPriority = (provider: AIProvider): AIProvider[] => {
    if (provider !== 'smart_cycle') return [provider];
    
    // For smart cycle, rotate the starting provider based on pageIndex
    // Only include providers that have an API key configured (except Gemini which uses system key)
    const availableProviders = smartCycleOrder.filter(p => {
      if (p === 'gemini' || p === 'local_nlp') return true;
      if (p === 'openrouter') return !!(providerConfig?.openRouterApiKey || localStorage.getItem('openrouter_api_key'));
      if (p === 'deepseek') return !!providerConfig?.deepSeekApiKey;
      if (p === 'groq') return !!providerConfig?.groqApiKey;
      if (p === 'sambanova') return !!providerConfig?.sambaNovaApiKey;
      if (p === 'siliconflow') return !!providerConfig?.siliconFlowApiKey;
      if (p === 'cerebras') return !!providerConfig?.cerebrasApiKey;
      if (p === 'wisdomgate') return !!providerConfig?.wisdomGateApiKey;
      if (p === 'huggingface') return !!hfApiKey;
      return false;
    });

    if (availableProviders.length === 0) return ['gemini'];

    // Rotate the list based on pageIndex
    const startIndex = pageIndex % availableProviders.length;
    return [
      ...availableProviders.slice(startIndex),
      ...availableProviders.slice(0, startIndex)
    ];
  };

  const providersToTry = getProviderPriority(aiProvider);

  for (const currentProvider of providersToTry) {
    try {
      if (currentProvider === 'ollama') {
        if (onModelSwitch) onModelSwitch(`Ollama (${ollamaModel})`);
        const notes = await attemptOllama(imageBase64, targetLanguage, masteryLevel, ollamaModel, ollamaEndpoint);
        return notes.map((n, i) => ({ ...n, id: `ollama-${pageIndex}-${i}`, pageIndex, targetLanguage }));
      } 
      
      if (currentProvider === 'openrouter') {
        const primaryModel = providerConfig?.openRouterModel || 'google/gemma-3-4b-it:free';
        try {
          if (onModelSwitch) onModelSwitch(`OpenRouter (${primaryModel})`);
          const notes = await attemptOpenRouter(imageBase64, targetLanguage, masteryLevel, primaryModel, providerConfig?.openRouterApiKey);
          return notes.map((n, i) => ({ ...n, id: `openrouter-${pageIndex}-${i}`, pageIndex, targetLanguage }));
        } catch (err) {
          console.warn(`OpenRouter primary model failed, trying fallback...`, err);
          const fallbackModel = 'openrouter/free'; // Using free as a reliable fallback
          if (onModelSwitch) onModelSwitch(`OpenRouter Fallback (${fallbackModel})`);
          const notes = await attemptOpenRouter(imageBase64, targetLanguage, masteryLevel, fallbackModel, providerConfig?.openRouterApiKey);
          return notes.map((n, i) => ({ ...n, id: `openrouter-fallback-${pageIndex}-${i}`, pageIndex, targetLanguage }));
        }
      }

      if (currentProvider === 'deepseek') {
        if (onModelSwitch) onModelSwitch('DeepSeek (V3)');
        const notes = await attemptGenericOpenAI(imageBase64, targetLanguage, masteryLevel, 'https://api.deepseek.com/v1/chat/completions', providerConfig?.deepSeekApiKey, 'deepseek-chat');
        return notes.map((n, i) => ({ ...n, id: `deepseek-${pageIndex}-${i}`, pageIndex, targetLanguage }));
      }

      if (currentProvider === 'groq') {
        if (onModelSwitch) onModelSwitch('Groq (Llama-3.2-90B-Vision)');
        const notes = await attemptGenericOpenAI(imageBase64, targetLanguage, masteryLevel, 'https://api.groq.com/openai/v1/chat/completions', providerConfig?.groqApiKey, 'llama-3.2-90b-vision-preview');
        return notes.map((n, i) => ({ ...n, id: `groq-${pageIndex}-${i}`, pageIndex, targetLanguage }));
      }

      if (currentProvider === 'sambanova') {
        if (onModelSwitch) onModelSwitch('SambaNova (Llama-4-70B)');
        const notes = await attemptGenericOpenAI(imageBase64, targetLanguage, masteryLevel, 'https://api.sambanova.ai/v1/chat/completions', providerConfig?.sambaNovaApiKey, 'Llama-3.1-70B-Instruct');
        return notes.map((n, i) => ({ ...n, id: `sambanova-${pageIndex}-${i}`, pageIndex, targetLanguage }));
      }

      if (currentProvider === 'siliconflow') {
        if (onModelSwitch) onModelSwitch('SiliconFlow (Qwen-2-VL)');
        const notes = await attemptGenericOpenAI(imageBase64, targetLanguage, masteryLevel, 'https://api.siliconflow.cn/v1/chat/completions', providerConfig?.siliconFlowApiKey, 'Qwen/Qwen2-VL-72B-Instruct');
        return notes.map((n, i) => ({ ...n, id: `siliconflow-${pageIndex}-${i}`, pageIndex, targetLanguage }));
      }

      if (currentProvider === 'cerebras') {
        if (onModelSwitch) onModelSwitch('Cerebras (Llama-3.3-70B)');
        const notes = await attemptGenericOpenAI(imageBase64, targetLanguage, masteryLevel, 'https://api.cerebras.ai/v1/chat/completions', providerConfig?.cerebrasApiKey, 'llama3.3-70b');
        return notes.map((n, i) => ({ ...n, id: `cerebras-${pageIndex}-${i}`, pageIndex, targetLanguage }));
      }

      if (currentProvider === 'wisdomgate') {
        if (onModelSwitch) onModelSwitch('Wisdom Gate (WG-Vision-Pro)');
        const notes = await attemptGenericOpenAI(imageBase64, targetLanguage, masteryLevel, 'https://api.wisdomgate.ai/v1/chat/completions', providerConfig?.wisdomGateApiKey, 'wg-vision-pro');
        return notes.map((n, i) => ({ ...n, id: `wisdomgate-${pageIndex}-${i}`, pageIndex, targetLanguage }));
      }

      if (currentProvider === 'huggingface') {
        if (onModelSwitch) onModelSwitch(`HF (${hfModel})`);
        const notes = await attemptHuggingFace(imageBase64, targetLanguage, masteryLevel, hfApiKey, hfModel);
        return notes.map((n, i) => ({ ...n, id: `hf-${pageIndex}-${i}`, pageIndex, targetLanguage }));
      }

      if (currentProvider === 'local_nlp') {
        return await performLocalOCRAnalysis(imageBase64, pageIndex, targetLanguage, true, onModelSwitch);
      }

      if (currentProvider === 'gemini') {
        for (const model of geminiModels) {
          try {
            if (onModelSwitch) onModelSwitch(model);
            const notes = await attemptAnalysis(model, imageBase64, targetLanguage, masteryLevel);
            return notes.map((n, i) => ({ ...n, id: `${model}-${pageIndex}-${i}`, pageIndex, targetLanguage }));
          } catch (err) {
            console.warn(`Fallback: ${model} failed...`);
          }
        }
      }
    } catch (err) {
      console.warn(`Smart Cycle: Provider ${currentProvider} failed, trying next...`, err);
    }
  }

  // Ultimate Gemini Default Fallback before OCR
  try {
    const defaultModel = 'gemini-3-flash-preview';
    if (onModelSwitch) onModelSwitch(`${defaultModel} (Default Fallback)`);
    const notes = await attemptAnalysis(defaultModel, imageBase64, targetLanguage, masteryLevel);
    return notes.map((n, i) => ({ ...n, id: `default-${pageIndex}-${i}`, pageIndex, targetLanguage }));
  } catch (err) {
    console.warn("Gemini default fallback failed, proceeding to OCR...");
  }

  try {
    return await performLocalOCRAnalysis(imageBase64, pageIndex, targetLanguage, false, onModelSwitch);
  } catch (ocrErr) {
    console.error("OCR/AI Waterfall failed, using default error note.");
  }

  return [{
    id: `failed-${pageIndex}`,
    pageIndex,
    originalText: "[System Error]",
    explanation: "Analysis failed. Please try a different page or check your connection.",
    type: "translation",
    targetLanguage,
    translations: { 
      Japanese: { 
        text: "解析に失敗しました", 
        reading: "Kaiseki ni shippai shimashita", 
        breakdown: [] 
      } 
    },
    boundingBox: { ymin: 10, xmin: 10, ymax: 30, xmax: 30 }
  }] as StudyNote[];
}

export async function generateTTS(text: string): Promise<string | undefined> {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: `Say naturally in Japanese: ${text.replace(/<[^>]*>/g, '')}` }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    });
    return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  } catch (err) {
    return undefined;
  }
}
