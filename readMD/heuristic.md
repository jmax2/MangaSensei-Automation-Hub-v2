# MangaSensei Local NLP Heuristics

## Current Implementation: Local NLP (Kuromoji + Wanakana + Translation Bridge)

The Local NLP engine serves as the final fallback in the MangaSensei analysis waterfall. When all AI providers fail (or when forced via settings), the system relies on client-side JavaScript libraries to parse and analyze text extracted via OCR (Tesseract.js).

### How It Works

1.  **OCR Extraction**: `Tesseract.js` scans the manga page image and extracts text blocks and their bounding boxes.
2.  **Translation Bridge**: If the source text is English, it is translated into Japanese using a translation service (Google Translate Lite, MyMemory, or DeepL).
3.  **Tokenization**: The Japanese text is passed to `Kuromoji.js`, a morphological analyzer. Kuromoji breaks the continuous string of Japanese text into individual tokens (words/particles).
4.  **Dictionary Lookup**: The system queries a local `IndexedDB` (JMDict) to provide English meanings for the tokens.
5.  **Transliteration**: `Wanakana.js` is used to convert the Katakana readings into Romaji (Latin alphabet) and Hiragana (for generating Ruby text/Furigana).
6.  **Assembly**: The tokens are assembled into a `StudyNote` object, mapping the grammatical breakdown to the original text.

### Supported Translation Engines for Local NLP
*   **Google Translate Lite**: Primary, high-speed, no-key endpoint.
*   **MyMemory**: Reliable fallback for translation.
*   **DeepL API**: High-quality translation (requires free tier API key).

### Current Issues & Limitations

*   **OCR Inaccuracies**: Tesseract.js is notoriously inaccurate with vertical Japanese text, handwritten fonts, or text over complex backgrounds. Garbage in = Garbage out.
*   **Translation Nuance**: Automated translation (even with DeepL) can miss manga-specific slang or cultural nuances.
*   **Dictionary Size**: While JMDict-Lite is efficient, it is still a significant download for the browser.

### Planned Improvements

1.  **On-Device AI Translation**: Integrate a model like TranslateGemma-4B via Transformers.js for 100% offline, high-quality translation.
2.  **Improved OCR Pre-processing**: Apply image filters (contrast, binarization) to the bounding box areas *before* passing them to Tesseract.
3.  **Context-Aware Translation**: Pass panel crops (images) along with the English text to the translation engine to help resolve ambiguous terms (e.g., *Hana* as flower vs. nose).
