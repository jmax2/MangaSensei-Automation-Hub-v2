
export type PreScreenMode = 'none' | 'ocr_lite' | 'ai_vision';

export type MasteryLevel = 'beginner' | 'intermediate' | 'advanced';
export type AIProvider = 'gemini' | 'ollama' | 'openrouter' | 'huggingface' | 'deepseek' | 'groq' | 'sambanova' | 'siliconflow' | 'cerebras' | 'wisdomgate' | 'smart_cycle' | 'local_nlp';

export type AutomationStatus = 'idle' | 'preparing' | 'analyzing' | 'completed' | 'error';

export interface WordBreakdown {
  japanese: string;
  romaji: string;
  meaning: string;
  notes: string;
  partOfSpeech: 'verb' | 'noun' | 'adjective' | 'adverb' | 'particle' | 'conjunction' | 'interjection' | 'unknown';
}

export interface JapaneseTranslation {
  text: string;
  reading: string;
  breakdown: WordBreakdown[];
}

/**
 * Represents a normalized bounding box on an image using percentage-based coordinates (0-100).
 */
export interface BoundingBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export interface StudyNote {
  id: string;
  pageIndex: number;
  originalText?: string;
  speaker?: string;
  translations: {
    Japanese: JapaneseTranslation;
    [key: string]: any;
  };
  targetLanguage: string;
  explanation: string;
  type: 'vocabulary' | 'grammar' | 'culture' | 'translation';
  boundingBox?: BoundingBox;
}

export interface AutomationChapter {
  id: string;
  name: string;
  images: MangaImage[];
  status: 'pending' | 'processing' | 'done' | 'error';
  progress: number;
  notes: StudyNote[];
  exportName: string;
  pageRange?: string;
}

export interface MangaImage {
  id: string;
  url: string;
  name: string;
  file: File;
}

export interface LogEntry {
  id: string;
  timestamp: Date;
  level: 'info' | 'success' | 'warning' | 'error' | 'ai';
  message: string;
}
