
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Zap, Terminal as TerminalIcon, Settings, Play, Layers, FolderPlus, 
  Plus, Cpu, BrainCircuit, Filter, Sparkles, Trash2, Download, 
  FileJson, CheckCircle2, Loader2, List, X, Info, BookOpen, ChevronLeft, 
  ChevronRight, Volume2, Maximize2, Minimize2, Eye, Star, MessageSquare,
  Hash, Table, ArrowLeft, MousePointer2, Columns, Scissors, MousePointer,
  Target, FileUp, Square
} from 'lucide-react';
import { 
  LogEntry, AutomationChapter, MangaImage, AutomationStatus, StudyNote, PreScreenMode, MasteryLevel, AIProvider 
} from './types';
import { preScreenPage, waterfallAnalysis, generateTTS } from './services/gemini';
import { storeBlob, getBlob, clearAllBlobs, deleteBlob, saveChapters, loadChapters, saveLogs, loadLogs } from './services/db';
import { canvasPool } from './services/canvasPool';

// --- Web Worker Setup ---
const workerCode = `
  self.onmessage = async (e) => {
    const { id, file, maxWidth } = e.data;
    try {
      const bitmap = await createImageBitmap(file);
      let width = bitmap.width;
      let height = bitmap.height;

      if (width > maxWidth) {
        height = (maxWidth / width) * height;
        width = maxWidth;
      }

      // Note: Inside Worker, we use OffscreenCanvas. 
      // Pooling OffscreenCanvas is worker-local. 
      // For this worker, we just use one-off instances as it processes serial chunks.
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      bitmap.close();
      
      self.postMessage({ id, blob, status: 'success' });
    } catch (err) {
      self.postMessage({ id, status: 'error', error: err.message });
    }
  };
`;

const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
const workerUrl = URL.createObjectURL(workerBlob);
const resizeWorker = new Worker(workerUrl);

// --- Constants & Utilities ---
const MAX_IMAGE_WIDTH = 1200;
const BATCH_SIZE = 5;

async function resizeImageWorker(file: File): Promise<Blob> {
  const id = Math.random().toString(36).substr(2, 9);
  return new Promise((resolve, reject) => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data.id === id) {
        resizeWorker.removeEventListener('message', handleMessage);
        if (e.data.status === 'success') resolve(e.data.blob);
        else reject(new Error(e.data.error));
      }
    };
    resizeWorker.addEventListener('message', handleMessage);
    resizeWorker.postMessage({ id, file, maxWidth: MAX_IMAGE_WIDTH });
  });
}

async function processFilesAsync(files: File[], onProgress: (p: number) => void): Promise<MangaImage[]> {
  const results: MangaImage[] = [];
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const chunk = files.slice(i, i + BATCH_SIZE);
    const processed = await Promise.all(chunk.map(async (file) => {
      const resizedBlob = await resizeImageWorker(file);
      const id = `img_${Math.random().toString(36).substr(2, 9)}`;
      await storeBlob(id, resizedBlob);
      return {
        id,
        url: URL.createObjectURL(resizedBlob), 
        name: file.name,
        file: null as any
      };
    }));
    results.push(...processed);
    onProgress(Math.round(((i + chunk.length) / files.length) * 100));
  }
  return results;
}

function decodeBase64(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

function parsePageRange(rangeStr: string | undefined, totalPages: number): number[] {
  const allIndices = Array.from({ length: totalPages }, (_, i) => i);
  if (!rangeStr || !rangeStr.trim()) return allIndices;
  const indices = new Set<number>();
  const parts = rangeStr.split(',');
  parts.forEach(part => {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-');
      const start = parseInt(startStr);
      const end = parseInt(endStr);
      if (!isNaN(start) && !isNaN(end)) {
        const min = Math.max(1, Math.min(start, end));
        const max = Math.min(totalPages, Math.max(start, end));
        for (let i = min; i <= max; i++) indices.add(i - 1);
      }
    } else {
      const p = parseInt(trimmed);
      if (!isNaN(p) && p >= 1 && p <= totalPages) indices.add(p - 1);
    }
  });
  const result = Array.from(indices).sort((a, b) => a - b);
  return result.length > 0 ? result : allIndices;
}

// --- Components ---

const ReaderView: React.FC<{ 
  chapter: AutomationChapter; 
  onClose: () => void;
  onUpdateNotes: (chapterId: string, notes: StudyNote[]) => void;
  pageUrls: Record<string, string>;
  setPageUrls: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onSwitchChapter: (direction: 'prev' | 'next') => void;
  hasPrevChapter: boolean;
  hasNextChapter: boolean;
}> = ({ chapter, onClose, onUpdateNotes, pageUrls, setPageUrls, onSwitchChapter, hasPrevChapter, hasNextChapter }) => {
  const [currentPage, setCurrentPage] = useState(0);
  const [selectedNote, setSelectedNote] = useState<StudyNote | null>(null);

  useEffect(() => {
    setCurrentPage(0);
    setSelectedNote(null);
  }, [chapter.id]);
  const [hoveredNote, setHoveredNote] = useState<StudyNote | null>(null);
  const [popoverPos, setPopoverPos] = useState({ x: 0, y: 0 });
  const [analysisMode, setAnalysisMode] = useState<'sentence' | 'word'>('sentence');
  const [isPlaying, setIsPlaying] = useState(false);
  const [showFurigana, setShowFurigana] = useState(true);
  const [viewType, setViewType] = useState<'single' | 'webtoon'>('single');
  const [leftWidth, setLeftWidth] = useState(320);
  const [rightWidth, setRightWidth] = useState(384);
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);
  
  // Resizing Logic
  const isResizingLeft = useRef(false);
  const isResizingRight = useRef(false);

  // Scroll Sync Refs
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingLeft.current) {
        setLeftWidth(Math.max(200, Math.min(500, e.clientX)));
      }
      if (isResizingRight.current) {
        setRightWidth(Math.max(250, Math.min(600, window.innerWidth - e.clientX)));
      }
    };
    const handleMouseUp = () => {
      isResizingLeft.current = false;
      isResizingRight.current = false;
      document.body.style.cursor = 'default';
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Load image URLs
  useEffect(() => {
    let active = true;
    const loadImages = async () => {
      const urls: Record<string, string> = {};
      const toLoad = viewType === 'webtoon' ? chapter.images : [chapter.images[currentPage]];
      
      for (const img of toLoad) {
        if (!pageUrls[img.id]) {
          const blob = await getBlob(img.id);
          if (blob && active) {
            urls[img.id] = URL.createObjectURL(blob);
          }
        }
      }
      if (active) {
        setPageUrls(prev => ({ ...prev, ...urls }));
      }
    };
    loadImages();
    return () => { active = false; };
  }, [chapter.images, currentPage, viewType]);

  // Sync scroll on mode switch
  useEffect(() => {
    if (viewType === 'webtoon') {
      const target = pageRefs.current[currentPage];
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }, [viewType, chapter.images]);

  // Keyboard Navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (viewType === 'webtoon') return;
      
      // Chapter switching with Shift
      if (e.shiftKey) {
        if (e.key === 'ArrowRight' && hasNextChapter) {
          onSwitchChapter('next');
          return;
        }
        if (e.key === 'ArrowLeft' && hasPrevChapter) {
          onSwitchChapter('prev');
          return;
        }
      }

      if (e.key === 'ArrowRight' && currentPage < chapter.images.length - 1) {
        setCurrentPage(p => p + 1);
        setSelectedNote(null);
      }
      if (e.key === 'ArrowLeft' && currentPage > 0) {
        setCurrentPage(p => p - 1);
        setSelectedNote(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentPage, chapter.images.length, viewType, hasNextChapter, hasPrevChapter, onSwitchChapter]);

  const page = chapter.images[currentPage];
  const pageNotes = useMemo(() => 
    chapter.notes.filter(n => n.pageIndex === currentPage), 
    [chapter.notes, currentPage]
  );

  const handleTTS = async (text: string) => {
    if (isPlaying) return;
    setIsPlaying(true);
    const cleanText = text.replace(/<[^>]*>/g, '');
    const base64 = await generateTTS(cleanText);
    if (base64) {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const bytes = decodeBase64(base64);
      const buffer = await decodeAudioData(bytes, audioCtx, 24000, 1);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.onended = () => setIsPlaying(false);
      source.start();
    } else {
      setIsPlaying(false);
    }
  };

  const deleteSingleNote = (noteId: string) => {
    const updated = chapter.notes.filter(n => n.id !== noteId);
    onUpdateNotes(chapter.id, updated);
    if (selectedNote?.id === noteId) setSelectedNote(null);
    if (hoveredNote?.id === noteId) setHoveredNote(null);
  };

  const deletePageNotes = (pageIdx: number) => {
    const updated = chapter.notes.filter(n => n.pageIndex !== pageIdx);
    onUpdateNotes(chapter.id, updated);
    if (selectedNote?.pageIndex === pageIdx) setSelectedNote(null);
    if (hoveredNote?.pageIndex === pageIdx) setHoveredNote(null);
  };

  const handleMouseMoveOverImage = (e: React.MouseEvent, note: StudyNote) => {
    setHoveredNote(note);
    setPopoverPos({ x: e.clientX, y: e.clientY });
  };

  const handleMouseLeaveImage = () => {
    setHoveredNote(null);
    setActiveWordIndex(null);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950 flex flex-col md:flex-row overflow-hidden animate-in fade-in zoom-in-95 duration-300">
      {/* Popover UI */}
      {hoveredNote && (
        <div 
          style={{ left: popoverPos.x + 20, top: popoverPos.y - 10 }}
          className="fixed z-[100] w-72 bg-slate-900/95 backdrop-blur-xl border border-slate-700/50 rounded-2xl shadow-2xl p-4 animate-in fade-in zoom-in-95 duration-200 pointer-events-auto"
          onMouseEnter={() => setHoveredNote(hoveredNote)}
          onMouseLeave={() => setHoveredNote(null)}
        >
          <div className="flex items-center justify-between mb-3">
             <span className="text-[9px] font-black uppercase tracking-widest text-indigo-400">{analysisMode === 'sentence' ? 'Translation' : 'Analysis'}</span>
             <div className="flex gap-2">
               <button onClick={() => deleteSingleNote(hoveredNote.id)} className="text-slate-500 hover:text-rose-400 transition-colors"><Trash2 size={14}/></button>
               <button onClick={() => setHoveredNote(null)} className="text-slate-500 hover:text-white transition-colors"><X size={14}/></button>
             </div>
          </div>

          <div className="space-y-3">
            {analysisMode === 'sentence' ? (
              <>
                <div className="space-y-1">
                  <p className="text-sm font-bold leading-tight">
                    {showFurigana ? (
                      <span dangerouslySetInnerHTML={{ __html: hoveredNote.translations.Japanese.text }} />
                    ) : (
                      hoveredNote.translations.Japanese.text.replace(/<rt>.*?<\/rt>/g, '').replace(/<[^>]*>/g, '')
                    )}
                  </p>
                  <p className="text-[8px] font-mono text-slate-500 uppercase">{hoveredNote.translations.Japanese.reading}</p>
                </div>
                <div className="pt-2 border-t border-slate-800">
                  <p className="text-[9px] font-black text-slate-500 uppercase mb-1">Original</p>
                  <p className="text-[10px] italic text-slate-300">"{hoveredNote.originalText}"</p>
                </div>
              </>
            ) : (
              <>
                {/* Smooth Reading Context in Word Mode */}
                <div className="pb-3 border-b border-slate-800/50 space-y-1">
                  <p className="text-sm font-bold leading-tight text-slate-100">
                    {showFurigana ? (
                      <span dangerouslySetInnerHTML={{ __html: hoveredNote.translations.Japanese.text }} />
                    ) : (
                      hoveredNote.translations.Japanese.text.replace(/<rt>.*?<\/rt>/g, '').replace(/<[^>]*>/g, '')
                    )}
                  </p>
                  <p className="text-[8px] font-mono text-slate-500 uppercase tracking-tight">{hoveredNote.translations.Japanese.reading}</p>
                </div>

                <div className="flex flex-wrap gap-1 py-3">
                  {hoveredNote.translations.Japanese.breakdown?.map((word, idx) => (
                    <button 
                      key={idx}
                      onMouseEnter={() => setActiveWordIndex(idx)}
                      className={`px-1.5 py-0.5 rounded-md text-xs font-bold transition-all ${activeWordIndex === idx ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                    >
                      {word.japanese}
                    </button>
                  ))}
                </div>
                {activeWordIndex !== null && hoveredNote.translations.Japanese.breakdown && hoveredNote.translations.Japanese.breakdown[activeWordIndex] ? (
                  <div className="p-2.5 bg-slate-950/50 rounded-xl border border-slate-800 space-y-1.5 animate-in slide-in-from-top-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black text-indigo-400">{hoveredNote.translations.Japanese.breakdown[activeWordIndex].romaji}</span>
                      <span className="text-[7px] font-black uppercase px-1 bg-indigo-500/20 text-indigo-400 rounded-sm">{hoveredNote.translations.Japanese.breakdown[activeWordIndex].partOfSpeech}</span>
                    </div>
                    <p className="text-xs font-bold text-slate-100">{hoveredNote.translations.Japanese.breakdown[activeWordIndex].meaning}</p>
                    <p className="text-[9px] text-slate-500 leading-tight">{hoveredNote.translations.Japanese.breakdown[activeWordIndex].notes}</p>
                  </div>
                ) : (
                   <p className="text-[9px] font-black text-slate-600 uppercase text-center py-4">Hover words for breakdown</p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Left Sidebar */}
      <div 
        style={{ width: leftWidth }}
        className="border-r border-slate-800 bg-slate-900/40 backdrop-blur-xl flex flex-col h-1/3 md:h-full shrink-0 relative"
      >
        <div className="p-4 border-b border-slate-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button 
              onClick={onClose} 
              className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-all text-[10px] font-black uppercase tracking-widest text-indigo-400"
            >
              <ArrowLeft size={14} /> Back
            </button>
            
            <div className="flex gap-1">
              <button 
                onClick={() => onSwitchChapter('prev')}
                disabled={!hasPrevChapter}
                className="p-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-slate-800 border border-slate-700 rounded-lg transition-all text-slate-400 hover:text-white"
                title="Previous Chapter"
              >
                <ChevronLeft size={14} />
              </button>
              <button 
                onClick={() => onSwitchChapter('next')}
                disabled={!hasNextChapter}
                className="p-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-slate-800 border border-slate-700 rounded-lg transition-all text-slate-400 hover:text-white"
                title="Next Chapter"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
          
          <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800 shadow-lg">
            <button 
              onClick={() => setAnalysisMode('sentence')}
              className={`p-1.5 rounded-lg transition-all ${analysisMode === 'sentence' ? 'bg-indigo-600 text-white shadow-[0_0_10px_rgba(79,70,229,0.3)]' : 'text-slate-500 hover:text-slate-300'}`}
              title="Sentence Mode"
            >
              <Target size={14} />
            </button>
            <button 
              onClick={() => setAnalysisMode('word')}
              className={`p-1.5 rounded-lg transition-all ${analysisMode === 'word' ? 'bg-indigo-600 text-white shadow-[0_0_10px_rgba(79,70,229,0.3)]' : 'text-slate-500 hover:text-slate-300'}`}
              title="Word Mode"
            >
              <MousePointer size={14} />
            </button>
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-2 no-scrollbar">
          <div className="px-2 py-3 mb-2 border-b border-slate-800/50">
             <div className="flex items-center gap-2 text-indigo-400 mb-1">
               <BookOpen size={14} />
               <span className="text-[9px] font-black uppercase tracking-[0.2em]">Source Registry</span>
             </div>
             <h2 className="text-xs font-black uppercase tracking-wider text-slate-100 break-all leading-tight">
               {chapter.name}
             </h2>
          </div>

          {chapter.images.map((img, idx) => (
            <div key={img.id} className="group relative">
              <button 
                onClick={() => { 
                  setCurrentPage(idx); 
                  setSelectedNote(null); 
                  if (viewType === 'webtoon') {
                    pageRefs.current[idx]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
                className={`w-full flex items-center gap-4 p-3 rounded-xl transition-all border ${currentPage === idx ? 'bg-indigo-600/10 border-indigo-500/50 text-white shadow-[inset_0_0_15px_rgba(79,70,229,0.1)]' : 'bg-slate-800/40 border-slate-700/50 text-slate-500 hover:border-slate-600'}`}
              >
                <div className="w-10 h-10 rounded-lg bg-slate-950 overflow-hidden shrink-0 border border-slate-800">
                  {pageUrls[img.id] ? (
                    <img src={pageUrls[img.id]} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full bg-slate-800 animate-pulse" />
                  )}
                </div>
                <div className="flex flex-col items-start overflow-hidden">
                  <span className="text-[10px] font-black uppercase">Page {idx + 1}</span>
                  <span className="text-[8px] font-bold text-slate-500 truncate w-full">{img.name}</span>
                </div>
                <div className="ml-auto text-[10px] font-black text-indigo-400/50">
                  {chapter.notes.filter(n => n.pageIndex === idx).length}
                </div>
              </button>
              
              {chapter.notes.some(n => n.pageIndex === idx) && (
                <button 
                  onClick={(e) => { e.stopPropagation(); deletePageNotes(idx); }}
                  className="absolute -top-1 -right-1 p-1 bg-slate-900 border border-slate-700 rounded-full text-slate-600 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
                  title="Wipe analysis"
                >
                  <Trash2 size={10} />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="p-6 bg-slate-950/50 border-t border-slate-800 flex items-center justify-center gap-4">
           <button 
            disabled={currentPage === 0 || viewType === 'webtoon'}
            onClick={() => setCurrentPage(prev => prev - 1)}
            className="p-3 bg-slate-800 border border-slate-700 rounded-xl disabled:opacity-30"
           >
            <ChevronLeft size={20} />
           </button>
           <span className="text-[10px] font-black uppercase tracking-widest">{currentPage + 1} / {chapter.images.length}</span>
           <button 
            disabled={currentPage === chapter.images.length - 1 || viewType === 'webtoon'}
            onClick={() => setCurrentPage(prev => prev + 1)}
            className="p-3 bg-slate-800 border border-slate-700 rounded-xl disabled:opacity-30"
           >
            <ChevronRight size={20} />
           </button>
        </div>

        {/* Left Resize Handle */}
        <div 
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-indigo-500/50 transition-colors z-10"
          onMouseDown={(e) => {
            isResizingLeft.current = true;
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
          }}
        />
      </div>

      {/* Main Reader Area */}
      <div 
        ref={scrollContainerRef}
        className={`flex-1 relative overflow-hidden group transition-all duration-300 ${viewType === 'single' ? 'flex items-center justify-center bg-black' : 'bg-slate-950 overflow-y-auto block p-4 space-y-6'}`}
      >
        {viewType === 'single' ? (
          pageUrls[page.id] && (
            <div className="relative max-h-full max-w-full shadow-2xl animate-in fade-in zoom-in-95 duration-500">
              <img src={pageUrls[page.id]} className="max-h-screen object-contain block" />
              <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                {pageNotes.map(note => {
                  const { xmin, ymin, xmax, ymax } = note.boundingBox || { xmin: 0, ymin: 0, xmax: 0, ymax: 0 };
                  const width = xmax - xmin;
                  const height = ymax - ymin;
                  const isSelected = selectedNote?.id === note.id;

                  return (
                    <rect 
                      key={note.id}
                      x={xmin} y={ymin} width={width} height={height}
                      onMouseMove={(e) => handleMouseMoveOverImage(e, note)}
                      onMouseLeave={handleMouseLeaveImage}
                      className={`pointer-events-auto cursor-pointer transition-all ${isSelected ? 'fill-indigo-500/30 stroke-indigo-400 stroke-[0.5]' : 'fill-transparent hover:fill-indigo-500/10 hover:stroke-indigo-400/50 hover:stroke-[0.3]'}`}
                      onClick={(e) => { e.stopPropagation(); setSelectedNote(note); }}
                    />
                  );
                })}
              </svg>
            </div>
          )
        ) : (
          <div className="max-w-4xl mx-auto space-y-8 pb-24">
            {chapter.images.map((img, idx) => (
              <div 
                key={img.id} 
                ref={el => { pageRefs.current[idx] = el; }}
                className={`relative w-full border rounded-2xl overflow-hidden bg-slate-900 min-h-[400px] transition-all duration-500 ${currentPage === idx ? 'border-indigo-500 ring-2 ring-indigo-500/20' : 'border-slate-800'}`}
              >
                {pageUrls[img.id] ? (
                  <>
                    <img src={pageUrls[img.id]} className="w-full block" loading="lazy" />
                    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                        {chapter.notes.filter(n => n.pageIndex === idx).map(note => {
                        const { xmin, ymin, xmax, ymax } = note.boundingBox || { xmin: 0, ymin: 0, xmax: 0, ymax: 0 };
                        const width = xmax - xmin;
                        const height = ymax - ymin;
                        const isSelected = selectedNote?.id === note.id;

                        return (
                            <rect 
                            key={note.id}
                            x={xmin} y={ymin} width={width} height={height}
                            onMouseMove={(e) => handleMouseMoveOverImage(e, note)}
                            onMouseLeave={handleMouseLeaveImage}
                            className={`pointer-events-auto cursor-pointer transition-all ${isSelected ? 'fill-indigo-500/30 stroke-indigo-400 stroke-[0.5]' : 'fill-transparent hover:fill-indigo-500/10 hover:stroke-indigo-400/50 hover:stroke-[0.3]'}`}
                            onClick={(e) => { e.stopPropagation(); setSelectedNote(note); setCurrentPage(idx); }}
                            />
                        );
                        })}
                    </svg>
                  </>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="flex flex-col items-center gap-4">
                      <Loader2 size={32} className="animate-spin text-indigo-500" />
                      <span className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Optimizing Page {idx + 1}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-slate-900/80 backdrop-blur-md border border-slate-700 p-2 rounded-2xl opacity-0 group-hover:opacity-100 transition-all shadow-2xl z-20">
          <button 
              onClick={() => setViewType(viewType === 'single' ? 'webtoon' : 'single')}
              title={viewType === 'single' ? "Webtoon Mode" : "Single Mode"}
              className={`p-2 rounded-xl transition-all ${viewType === 'webtoon' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}
          >
              {viewType === 'single' ? <Columns size={16} /> : <Layers size={16} />}
          </button>
          <div className="w-[1px] h-4 bg-slate-700 mx-1" />
          <button 
            onClick={() => setShowFurigana(!showFurigana)}
            className={`px-3 py-1.5 rounded-xl text-[10px] font-black transition-all ${showFurigana ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}
          >あ</button>
          <div className="w-[1px] h-4 bg-slate-700 mx-1" />
          <button className="p-2 text-slate-400 hover:text-white transition-colors" onClick={() => {
              if (document.fullscreenElement) document.exitFullscreen();
              else document.documentElement.requestFullscreen();
          }}><Maximize2 size={16} /></button>
        </div>
      </div>

      {/* Right Sidebar */}
      <div 
        style={{ width: rightWidth }}
        className="border-l border-slate-800 bg-slate-900/60 backdrop-blur-xl flex flex-col h-full shrink-0 relative"
      >
        {/* Right Resize Handle */}
        <div 
          className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-indigo-500/50 transition-colors z-10"
          onMouseDown={(e) => {
            isResizingRight.current = true;
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
          }}
        />

        <div className="p-6 border-b border-slate-800 flex items-center justify-between">
           <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-indigo-400 flex items-center gap-2">
             <Layers size={14} /> Analysis Feed
           </h2>
           {pageNotes.length > 0 && (
             <button 
               onClick={() => deletePageNotes(currentPage)}
               className="p-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-500 hover:text-rose-400 transition-colors"
               title="Wipe Current Page"
             >
               <Trash2 size={14} />
             </button>
           )}
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6 no-scrollbar">
          {selectedNote ? (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300 pb-20">
              <div className="p-5 bg-slate-950 border border-slate-800 rounded-2xl relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-3 flex gap-2">
                  <button onClick={() => deleteSingleNote(selectedNote.id)} className="text-slate-500 hover:text-rose-400 transition-colors p-1" title="Delete Note">
                    <Trash2 size={16} />
                  </button>
                  <button onClick={() => handleTTS(selectedNote.translations.Japanese.text)} className={`text-slate-500 hover:text-indigo-400 p-1 ${isPlaying ? 'animate-pulse text-indigo-400' : ''}`}>
                    <Volume2 size={18} />
                  </button>
                  <button className="text-slate-500 hover:text-yellow-400 p-1"><Star size={18} /></button>
                </div>
                
                <span className="text-[9px] font-black uppercase tracking-widest text-slate-600 mb-2 block">{selectedNote.type}</span>
                
                <div className="space-y-4">
                  <div>
                    <p className="text-xs text-slate-400 italic mb-2">Original Context:</p>
                    <p className="text-sm font-bold text-slate-200">{selectedNote.originalText}</p>
                    {selectedNote.speaker && <p className="text-[9px] font-black text-indigo-400 uppercase mt-1">Speaker: {selectedNote.speaker}</p>}
                  </div>
                  
                  <div className="pt-4 border-t border-slate-800">
                     <p className="text-xs text-slate-400 italic mb-2">Japanese Translation:</p>
                     <p className="text-lg font-bold leading-relaxed mb-1">
                        {showFurigana ? (
                          <span dangerouslySetInnerHTML={{ __html: selectedNote.translations.Japanese.text }} />
                        ) : (
                          selectedNote.translations.Japanese.text.replace(/<rt>.*?<\/rt>/g, '').replace(/<[^>]*>/g, '')
                        )}
                     </p>
                     <p className="text-[10px] font-mono text-slate-500 mt-2">{selectedNote.translations.Japanese.reading}</p>
                  </div>

                  {selectedNote.translations.Japanese.breakdown && selectedNote.translations.Japanese.breakdown.length > 0 && (
                    <div className="pt-4 border-t border-slate-800 overflow-hidden">
                       <p className="text-xs text-slate-400 italic mb-3 flex items-center gap-2"><Table size={12}/> Linguistic Breakdown:</p>
                       <div className="space-y-2">
                         {selectedNote.translations.Japanese.breakdown.map((item, i) => (
                           <div key={i} className="p-3 bg-slate-900/80 border border-slate-800 rounded-xl flex flex-col gap-1.5 hover:border-indigo-500/50 transition-colors">
                             <div className="flex items-center justify-between">
                               <span className="text-sm font-bold text-white">{item.japanese}</span>
                               <span className="text-[8px] font-black uppercase bg-indigo-600/20 text-indigo-400 px-1.5 py-0.5 rounded-md">{item.partOfSpeech}</span>
                             </div>
                             <div className="flex flex-col gap-0.5">
                               <p className="text-[9px] text-slate-400 font-mono italic">{item.romaji}</p>
                               <p className="text-[10px] text-indigo-300 font-bold">{item.meaning}</p>
                             </div>
                             <p className="text-[9px] text-slate-500 leading-tight border-t border-slate-800 pt-1.5 mt-0.5">{item.notes}</p>
                           </div>
                         ))}
                       </div>
                    </div>
                  )}

                  <div className="pt-4 border-t border-slate-800">
                    <p className="text-xs text-slate-400 italic mb-2">Analysis Explanation:</p>
                    <p className="text-xs text-slate-300 leading-relaxed bg-slate-900/50 p-3 rounded-xl border border-slate-800/50">
                      {selectedNote.explanation}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center opacity-30 px-10">
              <MessageSquare size={48} className="mb-4" />
              <p className="text-[10px] font-black uppercase tracking-widest leading-relaxed">Select a dialogue bubble<br/>to view linguistic breakdown</p>
            </div>
          )}
        </div>

        <div className="h-48 border-t border-slate-800 bg-slate-950/40 overflow-hidden flex flex-col">
          <div className="p-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between">
            <p className="text-[9px] font-black uppercase text-slate-500">Page Entities ({pageNotes.length})</p>
            {pageNotes.length > 0 && (
              <button onClick={() => deletePageNotes(currentPage)} className="text-[8px] font-black text-rose-500 uppercase hover:underline">Wipe All</button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1 no-scrollbar">
            {pageNotes.map(n => (
              <div key={n.id} className="flex gap-1 group">
                <button 
                  onClick={() => setSelectedNote(n)}
                  className={`flex-1 text-left p-2 rounded-lg text-[10px] transition-all truncate border ${selectedNote?.id === n.id ? 'bg-indigo-600/20 border-indigo-500/30 text-white' : 'hover:bg-slate-800 border-transparent text-slate-400'}`}
                >
                  <span className="font-bold text-indigo-400 mr-2">[{n.type.charAt(0).toUpperCase()}]</span>
                  {n.originalText}
                </button>
                <button 
                  onClick={() => deleteSingleNote(n.id)}
                  className="p-2 text-slate-700 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  // Config State
  const [viewMode, setViewMode] = useState<'hub' | 'reader'>('hub');
  const [activeReaderChapter, setActiveReaderChapter] = useState<AutomationChapter | null>(null);
  const [mode, setMode] = useState<'folder' | 'manual'>('folder');
  const [manualList, setManualList] = useState('');
  const [targetLanguage, setTargetLanguage] = useState('English');
  const [preScreenMode, setPreScreenMode] = useState<PreScreenMode>('ocr_lite');
  const [masteryLevel, setMasteryLevel] = useState<MasteryLevel>('beginner');
  const [aiProvider, setAiProvider] = useState<AIProvider>('gemini');
  const [openRouterApiKey, setOpenRouterApiKey] = useState(() => localStorage.getItem('openrouter_api_key') || '');
  const [openRouterModel, setOpenRouterModel] = useState(() => localStorage.getItem('openrouter_model') || 'google/gemma-3-4b-it:free');
  const [deepSeekApiKey, setDeepSeekApiKey] = useState(() => localStorage.getItem('deepseek_api_key') || '');
  const [groqApiKey, setGroqApiKey] = useState(() => localStorage.getItem('groq_api_key') || '');
  const [sambaNovaApiKey, setSambaNovaApiKey] = useState(() => localStorage.getItem('sambanova_api_key') || '');
  const [siliconFlowApiKey, setSiliconFlowApiKey] = useState(() => localStorage.getItem('siliconflow_api_key') || '');
  const [cerebrasApiKey, setCerebrasApiKey] = useState(() => localStorage.getItem('cerebras_api_key') || '');
  const [wisdomGateApiKey, setWisdomGateApiKey] = useState(() => localStorage.getItem('wisdomgate_api_key') || '');
  const [ollamaModel, setOllamaModel] = useState(() => localStorage.getItem('ollama_model') || 'llava');
  const [ollamaEndpoint, setOllamaEndpoint] = useState(() => localStorage.getItem('ollama_endpoint') || 'http://localhost:11434');
  const [hfApiKey, setHfApiKey] = useState(() => localStorage.getItem('hf_api_key') || '');
  const [hfModel, setHfModel] = useState(() => localStorage.getItem('hf_model') || 'google/gemma-3-27b-it');

  // Automation State
  const [chapters, setChapters] = useState<AutomationChapter[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<AutomationStatus>('idle');
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<number | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [bridgeWidth, setBridgeWidth] = useState(320);
  const [hubHeight, setHubHeight] = useState(50); // percentage for top section
  const [pageUrls, setPageUrls] = useState<Record<string, string>>({});
  const [selectedChapterIndex, setSelectedChapterIndex] = useState(0);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const stopRequested = useRef(false);
  const isResizingBridge = useRef(false);
  const isResizingHub = useRef(false);
  const selectedChapterRef = useRef<HTMLButtonElement>(null);

  // --- Persistence Logic ---
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingBridge.current) {
        setBridgeWidth(Math.max(260, Math.min(600, e.clientX - 24))); // 24 is padding
      }
      if (isResizingHub.current) {
        const mainArea = document.querySelector('main');
        if (mainArea) {
          const rect = mainArea.getBoundingClientRect();
          const relativeY = e.clientY - rect.top;
          setHubHeight(Math.max(20, Math.min(80, (relativeY / rect.height) * 100)));
        }
      }
    };
    const handleMouseUp = () => {
      isResizingBridge.current = false;
      isResizingHub.current = false;
      document.body.style.cursor = 'default';
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  useEffect(() => {
    if (viewMode !== 'reader' || activeReaderChapter) return;

    const readableChapters = chapters.filter(c => c.images.length > 0);
    if (readableChapters.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        setSelectedChapterIndex(prev => (prev + 1) % readableChapters.length);
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        setSelectedChapterIndex(prev => (prev - 1 + readableChapters.length) % readableChapters.length);
        e.preventDefault();
      } else if (e.key === 'Enter') {
        startReading(readableChapters[selectedChapterIndex]);
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [viewMode, activeReaderChapter, chapters, selectedChapterIndex]);

  useEffect(() => {
    if (selectedChapterRef.current) {
      selectedChapterRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedChapterIndex]);

  useEffect(() => {
    const readableCount = chapters.filter(c => c.images.length > 0).length;
    if (readableCount === 0) {
      setSelectedChapterIndex(0);
    } else if (selectedChapterIndex >= readableCount) {
      setSelectedChapterIndex(readableCount - 1);
    }
  }, [chapters, selectedChapterIndex]);

  useEffect(() => {
    const init = async () => {
      const savedChapters = await loadChapters();
      const savedLogs = await loadLogs();
      
      if (savedChapters.length > 0) {
        setChapters(savedChapters);
        // Re-hydrate page URLs from Blobs
        const urls: Record<string, string> = {};
        for (const ch of savedChapters) {
          for (const img of ch.images) {
            const blob = await getBlob(img.id);
            if (blob) {
              urls[img.id] = URL.createObjectURL(blob);
            }
          }
        }
        setPageUrls(prev => ({ ...prev, ...urls }));
      }
      
      if (savedLogs.length > 0) {
        setLogs(savedLogs);
      }
      setIsLoaded(true);
    };
    init();
  }, []);

  useEffect(() => {
    if (isLoaded) {
      saveChapters(chapters);
    }
  }, [chapters, isLoaded]);

  useEffect(() => {
    if (isLoaded) {
      saveLogs(logs);
    }
  }, [logs, isLoaded]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = (message: string, level: LogEntry['level'] = 'info') => {
    setLogs(prev => [...prev, { id: Math.random().toString(36).substr(2, 9), timestamp: new Date(), level, message }]);
  };

  const removeChapter = async (id: string) => {
    const ch = chapters.find(c => c.id === id);
    if (ch) {
      await Promise.all(ch.images.map(img => deleteBlob(img.id)));
    }
    setChapters(prev => prev.filter(c => c.id !== id));
    addLog("Chapter removed and data purged.", "info");
  };

  const updateChapterRange = (id: string, range: string) => {
    setChapters(prev => prev.map(c => c.id === id ? { ...c, pageRange: range } : c));
  };

  const onUpdateNotes = (chapterId: string, notes: StudyNote[]) => {
    setChapters(prev => prev.map(c => c.id === chapterId ? { ...c, notes } : c));
    if (activeReaderChapter?.id === chapterId) {
       setActiveReaderChapter(prev => prev ? { ...prev, notes } : null);
    }
  };

  const clearAllChapters = async () => {
    await clearAllBlobs();
    setChapters([]);
    addLog("Staging area and local database cleared.", "warning");
  };

  const handleFolderBatch = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    if (files.length === 0) return;

    setStatus('preparing');
    addLog(`Preprocessing ${files.length} files via Off-screen Worker...`, 'info');

    const folderMap = new Map<string, File[]>();
    files.forEach(file => {
      const pathParts = file.webkitRelativePath.split('/');
      let folderName = pathParts.length > 1 ? pathParts[pathParts.length - 2] : 'Unsorted';
      if (!folderMap.has(folderName)) folderMap.set(folderName, []);
      folderMap.get(folderName)?.push(file);
    });

    const newEntries: AutomationChapter[] = [];
    const folders = Array.from(folderMap.entries());
    
    for (let i = 0; i < folders.length; i++) {
      const [name, folderFiles] = folders[i];
      const validImageFiles = folderFiles.filter(f => f.type.startsWith('image/'))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      
      if (validImageFiles.length > 0) {
        setImportProgress(Math.round((i / folders.length) * 100));
        const processedImages = await processFilesAsync(validImageFiles, (p) => {});
        newEntries.push({
          id: Math.random().toString(36).substr(2, 9),
          name: name,
          exportName: name.replace(/[^a-z0-9]/gi, '_'),
          images: processedImages,
          status: 'pending',
          progress: 0,
          notes: []
        });
      }
    }

    setChapters(prev => [...prev, ...newEntries].sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric: true})).slice(0, 50));
    addLog(`Optimized ${newEntries.length} chapters. Data persisted to IndexedDB.`, 'success');
    setStatus('idle');
    setImportProgress(null);
    e.target.value = '';
  };

  const prepareManualSlots = () => {
    const lines = manualList.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return;
    const newChapters: AutomationChapter[] = lines.map(line => ({
      id: Math.random().toString(36).substr(2, 9),
      name: line.trim(),
      exportName: line.trim().replace(/[^a-z0-9]/gi, '_'),
      images: [],
      status: 'pending',
      progress: 0,
      notes: []
    }));
    setChapters(prev => [...prev, ...newChapters]);
    addLog(`Registered ${newChapters.length} manual chapter slots.`, 'info');
    setManualList('');
  };

  const handleSlotUpload = async (e: React.ChangeEvent<HTMLInputElement>, chapterId: string) => {
    const files = Array.from(e.target.files || []) as File[];
    const validImageFiles = files.filter(f => f.type.startsWith('image/'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    setStatus('preparing');
    addLog(`Optimizing ${validImageFiles.length} images...`, 'info');
    const processedImages = await processFilesAsync(validImageFiles, (p) => setImportProgress(p));
    setChapters(prev => prev.map(ch => ch.id === chapterId ? { ...ch, images: processedImages } : ch));
    addLog(`Slot updated with optimized data.`, 'info');
    setStatus('idle');
    setImportProgress(null);
  };

  const handleNoteImport = async (e: React.ChangeEvent<HTMLInputElement>, chapterId: string) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const importedNotes = JSON.parse(text);
      
      if (!Array.isArray(importedNotes)) {
        throw new Error("Invalid format: Expected an array of notes.");
      }

      setChapters(prev => prev.map(ch => {
        if (ch.id === chapterId) {
          return {
            ...ch,
            notes: importedNotes,
            status: 'done',
            progress: 100
          };
        }
        return ch;
      }));

      addLog(`Imported ${importedNotes.length} notes for chapter.`, 'success');
    } catch (err: any) {
      addLog(`Import failed: ${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  };

  const executeProtocol = async () => {
    if (status === 'analyzing') return;
    const pendingChapters = chapters.filter(c => c.images.length > 0 && c.status !== 'done');
    if (pendingChapters.length === 0) {
      addLog("Abort: No valid pending chapters found.", "error");
      return;
    }

    stopRequested.current = false;
    setStatus('analyzing');
    addLog("Protocol Execution: Multi-Tab Parallel mode enabled (Concurrency: 2)", "ai");

    for (const chapter of pendingChapters) {
      if (stopRequested.current) break;
      setActiveChapterId(chapter.id);
      setChapters(prev => prev.map(c => c.id === chapter.id ? { ...c, status: 'processing' } : c));
      
      const targetIndices = parsePageRange(chapter.pageRange, chapter.images.length);
      addLog(`Analyzing: ${chapter.name} (${targetIndices.length} pages)`, 'ai');

      let chapterNotes: StudyNote[] = [];
      const CONCURRENCY = 2;

      for (let idx = 0; idx < targetIndices.length; idx += CONCURRENCY) {
        if (stopRequested.current) break;
        
        const chunk = targetIndices.slice(idx, idx + CONCURRENCY);
        
        const pageResults = await Promise.all(chunk.map(async (i) => {
          const img = chapter.images[i];
          try {
            const blob = await getBlob(img.id);
            if (!blob) throw new Error("Database fetch failed");

            const base64 = await new Promise<string>(r => {
              const reader = new FileReader();
              reader.onloadend = () => r((reader.result as string).split(',')[1]);
              reader.readAsDataURL(blob);
            });

            if (preScreenMode !== 'none') {
              const pre = await preScreenPage(base64, preScreenMode);
              if (pre.dialogueBubbleCount < 1) {
                addLog(`- P${i+1}: Skipping (Low density)`, 'info');
                return [];
              }
            }

            addLog(`- P${i+1}: Waterfall Analysis...`, 'info');
            return await waterfallAnalysis(base64, i, targetLanguage, masteryLevel, aiProvider, ollamaModel, ollamaEndpoint, hfApiKey, hfModel, (model) => {
              addLog(`  > P${i+1} Fallback: ${model}`, 'ai');
            }, {
              openRouterApiKey,
              openRouterModel,
              deepSeekApiKey,
              groqApiKey,
              sambaNovaApiKey,
              siliconFlowApiKey,
              cerebrasApiKey,
              wisdomGateApiKey
            });
          } catch (err: any) {
            addLog(`  ! Error P${i+1}: ${err.message}`, 'error');
            return [];
          }
        }));

        const newNotes = pageResults.flat();
        chapterNotes = [...chapterNotes, ...newNotes];
        const prog = Math.round(((idx + chunk.length) / targetIndices.length) * 100);
        setChapters(prev => prev.map(c => c.id === chapter.id ? { ...c, progress: prog, notes: [...c.notes, ...newNotes] } : c));
      }

      if (stopRequested.current) {
        setChapters(prev => prev.map(c => c.id === chapter.id ? { ...c, status: 'pending' } : c));
        break;
      }

      const finalChapter = { ...chapter, status: 'done' as const, notes: chapterNotes, progress: 100 };
      setChapters(prev => prev.map(c => c.id === chapter.id ? finalChapter : c));
      addLog(`Complete: ${chapter.name}. Total Notes: ${chapterNotes.length}`, 'success');
      downloadJson(finalChapter);
    }

    if (stopRequested.current) {
      addLog("Protocol stopped by user.", "warning");
      setStatus('idle');
    } else {
      setStatus('completed');
      addLog("Automation Protocol concluded.", "success");
    }
    setActiveChapterId(null);
  };

  const downloadJson = (chapter: AutomationChapter) => {
    const content = JSON.stringify(chapter.notes, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${chapter.exportName}_notes.json`;
    a.click();
  };

  const startReading = (chapter: AutomationChapter) => {
    if (chapter.notes.length === 0 && chapter.images.length > 0 && chapter.status !== 'done') {
      addLog("Reader Warning: Analysis still in progress.", "warning");
    } else if (chapter.images.length === 0) {
      addLog("Reader Error: No images available.", "error");
      return;
    }
    setActiveReaderChapter(chapter);
    setViewMode('reader');
    setSelectedChapterIndex(0);
  };

  const handleUpdateNotes = (chapterId: string, notes: StudyNote[]) => {
    setChapters(prev => prev.map(c => c.id === chapterId ? { ...c, notes } : c));
  };

  const handleSwitchChapter = (direction: 'prev' | 'next') => {
    const readableChapters = chapters.filter(c => c.images.length > 0);
    const currentIndex = readableChapters.findIndex(c => c.id === activeReaderChapter?.id);
    if (currentIndex === -1) return;

    let nextIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1;
    if (nextIndex >= 0 && nextIndex < readableChapters.length) {
      setActiveReaderChapter(readableChapters[nextIndex]);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 font-sans overflow-hidden">
      <header className="h-16 border-b border-slate-800 bg-slate-900/50 backdrop-blur-xl flex items-center justify-between px-6 shrink-0 z-30">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-[0_0_20px_rgba(79,70,229,0.4)]">
              <Zap size={22} fill="white" />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tighter uppercase">MangaSensei</h1>
              <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest -mt-1">Automation Hub</p>
            </div>
          </div>
          <nav className="hidden md:flex items-center bg-slate-950 border border-slate-800 rounded-xl p-1">
            <button onClick={() => setViewMode('hub')} className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${viewMode === 'hub' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}>Protocol</button>
            <button disabled={chapters.length === 0} onClick={() => { setViewMode('reader'); setSelectedChapterIndex(0); }} className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all disabled:opacity-30 ${viewMode === 'reader' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}>Reader</button>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={clearAllChapters} title="Purge Databases" className="text-slate-500 hover:text-rose-400 transition-colors p-2"><Trash2 size={20}/></button>
          <button className="p-2 bg-slate-800 rounded-lg border border-slate-700 text-slate-400"><Settings size={20}/></button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden p-6 gap-6 relative">
        <section 
          style={{ width: bridgeWidth }}
          className="flex flex-col gap-6 shrink-0 overflow-y-auto no-scrollbar relative"
        >
          <div className="bg-slate-900/60 border border-slate-800 rounded-[2rem] p-6 shadow-2xl backdrop-blur-md flex flex-col gap-5 h-full">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.3em] text-indigo-400"><BrainCircuit size={14} /> The Bridge</h2>
              <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${chapters.length >= 50 ? 'bg-rose-500/20 text-rose-400' : 'bg-indigo-500/20 text-indigo-400'}`}>{chapters.length} Slots</span>
            </div>
            <div className="space-y-4 flex-1 overflow-y-auto no-scrollbar">
              <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800">
                <button onClick={() => setMode('folder')} className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${mode === 'folder' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}>Folders</button>
                <button onClick={() => setMode('manual')} className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${mode === 'manual' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}>Manual</button>
              </div>
              {mode === 'folder' ? (
                <label className="block w-full cursor-pointer group">
                  <div className="flex flex-col items-center justify-center gap-3 py-10 bg-slate-800/40 border-2 border-dashed border-slate-700 rounded-2xl group-hover:border-indigo-500 group-hover:bg-slate-800/60 transition-all relative overflow-hidden">
                    {importProgress !== null && (
                      <div className="absolute inset-0 bg-indigo-600/10 flex items-center justify-center backdrop-blur-sm">
                        <div className="text-center">
                          <Loader2 size={24} className="animate-spin text-indigo-400 mb-2 mx-auto" />
                          <span className="text-[10px] font-black text-indigo-400">{importProgress}% Scaling...</span>
                        </div>
                      </div>
                    )}
                    <FolderPlus size={32} className="text-indigo-400" />
                    <div className="text-center">
                      <span className="block text-[10px] font-black uppercase tracking-widest text-slate-300">Add Folder Batch</span>
                      <span className="text-[8px] text-slate-500 uppercase font-bold">Worker + IndexedDB Pipeline</span>
                    </div>
                  </div>
                  {/* @ts-ignore */}
                  <input type="file" webkitdirectory="" directory="" multiple className="hidden" onChange={handleFolderBatch} disabled={status === 'preparing'} />
                </label>
              ) : (
                <div className="space-y-3">
                  <textarea value={manualList} onChange={e => setManualList(e.target.value)} className="w-full h-32 bg-slate-800/50 border border-slate-700 rounded-xl py-3 px-4 text-xs font-bold text-white focus:outline-none focus:border-indigo-500 resize-none" placeholder="Chapter_01&#10;The_Arrival..."/>
                  <button onClick={prepareManualSlots} className="w-full py-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all"><List size={14} className="inline mr-2" /> Prepare Slots</button>
                </div>
              )}
                <div className="pt-4 space-y-3 border-t border-slate-800">
                  <div className="space-y-2 px-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-black text-slate-500 uppercase">Provider Config</span>
                    </div>
                    <select 
                      value={aiProvider} 
                      onChange={(e) => setAiProvider(e.target.value as AIProvider)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-[10px] font-black uppercase tracking-widest text-white focus:outline-none focus:border-indigo-600 transition-colors"
                    >
                      <option value="gemini">Gemini (Default)</option>
                      <option value="smart_cycle">Smart Cycle (Free Tier Max)</option>
                      <option value="local_nlp">Local NLP (No AI)</option>
                      <option value="ollama">Ollama (Local)</option>
                      <option value="openrouter">OpenRouter</option>
                      <option value="deepseek">DeepSeek</option>
                      <option value="groq">Groq</option>
                      <option value="sambanova">SambaNova</option>
                      <option value="siliconflow">SiliconFlow</option>
                      <option value="cerebras">Cerebras</option>
                      <option value="wisdomgate">Wisdom Gate</option>
                      <option value="huggingface">Hugging Face</option>
                    </select>
                    {aiProvider === 'openrouter' && (
                      <div className="mt-2 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] font-black text-slate-500 uppercase">OpenRouter Config</span>
                        </div>
                        <input
                          type="password"
                          value={openRouterApiKey}
                          onChange={(e) => {
                            setOpenRouterApiKey(e.target.value);
                            localStorage.setItem('openrouter_api_key', e.target.value);
                          }}
                          placeholder="API Key (sk-or-v1-...)"
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-[10px] font-mono text-white focus:outline-none focus:border-indigo-600 transition-colors"
                        />
                        <input
                          type="text"
                          value={openRouterModel}
                          onChange={(e) => {
                            setOpenRouterModel(e.target.value);
                            localStorage.setItem('openrouter_model', e.target.value);
                          }}
                          placeholder="Model (e.g. google/gemma-3-4b-it:free)"
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-[10px] font-mono text-white focus:outline-none focus:border-indigo-600 transition-colors"
                        />
                      </div>
                    )}
                    {aiProvider === 'deepseek' && (
                      <div className="mt-2 space-y-2">
                        <span className="text-[9px] font-black text-slate-500 uppercase">DeepSeek API Key</span>
                        <input
                          type="password"
                          value={deepSeekApiKey}
                          onChange={(e) => {
                            setDeepSeekApiKey(e.target.value);
                            localStorage.setItem('deepseek_api_key', e.target.value);
                          }}
                          placeholder="sk-..."
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-[10px] font-mono text-white focus:outline-none focus:border-indigo-600 transition-colors"
                        />
                      </div>
                    )}
                    {aiProvider === 'groq' && (
                      <div className="mt-2 space-y-2">
                        <span className="text-[9px] font-black text-slate-500 uppercase">Groq API Key</span>
                        <input
                          type="password"
                          value={groqApiKey}
                          onChange={(e) => {
                            setGroqApiKey(e.target.value);
                            localStorage.setItem('groq_api_key', e.target.value);
                          }}
                          placeholder="gsk_..."
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-[10px] font-mono text-white focus:outline-none focus:border-indigo-600 transition-colors"
                        />
                      </div>
                    )}
                    {aiProvider === 'sambanova' && (
                      <div className="mt-2 space-y-2">
                        <span className="text-[9px] font-black text-slate-500 uppercase">SambaNova API Key</span>
                        <input
                          type="password"
                          value={sambaNovaApiKey}
                          onChange={(e) => {
                            setSambaNovaApiKey(e.target.value);
                            localStorage.setItem('sambanova_api_key', e.target.value);
                          }}
                          placeholder="API Key"
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-[10px] font-mono text-white focus:outline-none focus:border-indigo-600 transition-colors"
                        />
                      </div>
                    )}
                    {aiProvider === 'siliconflow' && (
                      <div className="mt-2 space-y-2">
                        <span className="text-[9px] font-black text-slate-500 uppercase">SiliconFlow API Key</span>
                        <input
                          type="password"
                          value={siliconFlowApiKey}
                          onChange={(e) => {
                            setSiliconFlowApiKey(e.target.value);
                            localStorage.setItem('siliconflow_api_key', e.target.value);
                          }}
                          placeholder="sk-..."
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-[10px] font-mono text-white focus:outline-none focus:border-indigo-600 transition-colors"
                        />
                      </div>
                    )}
                    {aiProvider === 'cerebras' && (
                      <div className="mt-2 space-y-2">
                        <span className="text-[9px] font-black text-slate-500 uppercase">Cerebras API Key</span>
                        <input
                          type="password"
                          value={cerebrasApiKey}
                          onChange={(e) => {
                            setCerebrasApiKey(e.target.value);
                            localStorage.setItem('cerebras_api_key', e.target.value);
                          }}
                          placeholder="csk_..."
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-[10px] font-mono text-white focus:outline-none focus:border-indigo-600 transition-colors"
                        />
                      </div>
                    )}
                    {aiProvider === 'wisdomgate' && (
                      <div className="mt-2 space-y-2">
                        <span className="text-[9px] font-black text-slate-500 uppercase">Wisdom Gate API Key</span>
                        <input
                          type="password"
                          value={wisdomGateApiKey}
                          onChange={(e) => {
                            setWisdomGateApiKey(e.target.value);
                            localStorage.setItem('wisdomgate_api_key', e.target.value);
                          }}
                          placeholder="API Key"
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-[10px] font-mono text-white focus:outline-none focus:border-indigo-600 transition-colors"
                        />
                      </div>
                    )}
                    {aiProvider === 'ollama' && (
                      <div className="mt-2 space-y-3">
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-black text-slate-500 uppercase">Ollama Model</span>
                          </div>
                          <input
                            type="text"
                            value={ollamaModel}
                            onChange={(e) => {
                              setOllamaModel(e.target.value);
                              localStorage.setItem('ollama_model', e.target.value);
                            }}
                            placeholder="e.g. llava, llama3"
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-[10px] font-mono text-white focus:outline-none focus:border-indigo-600 transition-colors"
                          />
                        </div>
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-black text-slate-500 uppercase">Ollama Endpoint</span>
                          </div>
                          <input
                            type="text"
                            value={ollamaEndpoint}
                            onChange={(e) => {
                              setOllamaEndpoint(e.target.value);
                              localStorage.setItem('ollama_endpoint', e.target.value);
                            }}
                            placeholder="http://localhost:11434"
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-[10px] font-mono text-white focus:outline-none focus:border-indigo-600 transition-colors"
                          />
                        </div>
                      </div>
                    )}
                    {aiProvider === 'huggingface' && (
                      <div className="mt-2 space-y-3">
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-black text-slate-500 uppercase">HF API Key</span>
                          </div>
                          <input
                            type="password"
                            value={hfApiKey}
                            onChange={(e) => {
                              setHfApiKey(e.target.value);
                              localStorage.setItem('hf_api_key', e.target.value);
                            }}
                            placeholder="hf_..."
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-[10px] font-mono text-white focus:outline-none focus:border-indigo-600 transition-colors"
                          />
                        </div>
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-black text-slate-500 uppercase">HF Model</span>
                          </div>
                          <input
                            type="text"
                            value={hfModel}
                            onChange={(e) => {
                              setHfModel(e.target.value);
                              localStorage.setItem('hf_model', e.target.value);
                            }}
                            placeholder="google/gemma-3-27b-it"
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-[10px] font-mono text-white focus:outline-none focus:border-indigo-600 transition-colors"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="space-y-2 px-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-black text-slate-500 uppercase">Mastery Level</span>
                    </div>
                    <select 
                      value={masteryLevel} 
                      onChange={(e) => setMasteryLevel(e.target.value as MasteryLevel)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-[10px] font-black uppercase tracking-widest text-white focus:outline-none focus:border-indigo-600 transition-colors"
                    >
                      <option value="beginner">Beginner</option>
                      <option value="intermediate">Intermediate</option>
                      <option value="advanced">Advanced</option>
                    </select>
                  </div>
                  <div className="space-y-2 px-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-black text-slate-500 uppercase">Filter Protocol</span>
                      <span className="text-[8px] font-bold text-indigo-400 uppercase">Speed Optimized</span>
                    </div>
                    <select 
                      value={preScreenMode} 
                      onChange={(e) => setPreScreenMode(e.target.value as PreScreenMode)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-[10px] font-black uppercase tracking-widest text-white focus:outline-none focus:border-indigo-600 transition-colors"
                    >
                      <option value="ocr_lite">OCR + Gemini Lite</option>
                      <option value="ai_vision">AI Vision (Flash)</option>
                      <option value="none">None (Analyze All)</option>
                    </select>
                  </div>
                  {status === 'analyzing' ? (
                    <button 
                      onClick={() => { stopRequested.current = true; addLog("Stop requested. Finishing current batch...", "warning"); }} 
                      className="w-full py-5 bg-rose-600 hover:bg-rose-500 rounded-2xl flex items-center justify-center gap-3 text-[11px] font-black uppercase tracking-[0.2em] shadow-xl shadow-rose-600/10 transition-all animate-pulse"
                    >
                      <Square size={18} fill="white" /> Stop Protocol
                    </button>
                  ) : (
                    <button 
                      onClick={executeProtocol} 
                      disabled={chapters.length === 0 || status === 'preparing'} 
                      className="w-full py-5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 rounded-2xl flex items-center justify-center gap-3 text-[11px] font-black uppercase tracking-[0.2em] shadow-xl shadow-indigo-600/10 transition-all"
                    >
                      <Play size={18} /> Execute Protocol
                    </button>
                  )}
              </div>
            </div>
          </div>
          {/* Bridge Resize Handle */}
          <div 
            className="absolute top-0 -right-3 w-6 h-full cursor-col-resize flex items-center justify-center group z-20"
            onMouseDown={(e) => {
              isResizingBridge.current = true;
              document.body.style.cursor = 'col-resize';
              e.preventDefault();
            }}
          >
            <div className="w-1 h-12 bg-slate-800 rounded-full group-hover:bg-indigo-500 transition-colors" />
          </div>
        </section>

        <section className="flex-1 flex flex-col gap-6 overflow-hidden relative">
          {viewMode === 'hub' ? (
            <>
              <div 
                style={{ height: `${hubHeight}%` }}
                className="bg-slate-900/60 border border-slate-800 rounded-[2.5rem] p-8 overflow-y-auto no-scrollbar shadow-2xl backdrop-blur-md relative"
              >
                <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-6 pb-10">
                    {chapters.length === 0 && (
                      <div className="col-span-full py-20 border-2 border-dashed border-slate-800 rounded-[2rem] flex flex-col items-center justify-center text-slate-700 opacity-20"><Sparkles size={48} className="mb-4" /><p className="text-xs font-black uppercase tracking-widest text-center">Bridge Idle</p></div>
                    )}
                    {chapters.map(ch => (
                      <div key={ch.id} className={`group relative p-5 bg-slate-800/40 border-2 rounded-3xl transition-all ${activeChapterId === ch.id ? 'border-indigo-500 shadow-lg scale-105' : 'border-slate-800 hover:border-slate-700'}`}>
                        <div className="absolute -top-2 -right-2 flex gap-1 items-center opacity-0 group-hover:opacity-100 transition-all z-10">
                          <button 
                            onClick={() => downloadJson(ch)} 
                            title="Download Extraction"
                            className="w-7 h-7 bg-indigo-600 border border-indigo-500 rounded-full flex items-center justify-center text-white hover:bg-indigo-500 shadow-lg"
                          >
                            <Download size={14} />
                          </button>
                          <label 
                            className="w-7 h-7 bg-purple-600 border border-purple-500 rounded-full flex items-center justify-center text-white hover:bg-purple-500 shadow-lg cursor-pointer"
                            title="Import Previous Notes"
                          >
                            <FileUp size={14} />
                            <input type="file" accept=".json" className="hidden" onChange={(e) => handleNoteImport(e, ch.id)} />
                          </label>
                          <button 
                            onClick={() => removeChapter(ch.id)} 
                            title="Delete Slot"
                            className="w-7 h-7 bg-slate-900 border border-slate-800 rounded-full flex items-center justify-center text-slate-500 hover:text-rose-400 shadow-lg"
                          >
                            <X size={14} />
                          </button>
                        </div>
                        
                        <div className="flex items-start justify-between mb-4 overflow-hidden">
                          <div className="space-y-1 overflow-hidden">
                            <h3 className="text-xs font-black uppercase truncate pr-2">{ch.name}</h3>
                            <p className={`text-[8px] font-bold uppercase ${ch.images.length === 0 ? 'text-rose-400' : 'text-slate-500'}`}>{ch.images.length} Pages Indexed</p>
                          </div>
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${ch.status === 'done' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-950 text-slate-600'}`}>{ch.status === 'done' ? <CheckCircle2 size={16} /> : <FileJson size={16} />}</div>
                        </div>

                        {ch.images.length > 0 && ch.status !== 'done' && (
                          <div className="mb-4 space-y-1 bg-slate-950/30 p-2 rounded-xl border border-slate-800/50">
                             <div className="flex items-center gap-2 mb-1">
                               <Hash size={10} className="text-indigo-500" />
                               <label className="text-[8px] font-black text-slate-500 uppercase tracking-wider">Page Scope</label>
                             </div>
                             <input 
                              type="text"
                              placeholder="Default: All (e.g. 1,3,5-10)"
                              disabled={ch.status === 'processing'}
                              value={ch.pageRange || ''}
                              onChange={(e) => updateChapterRange(ch.id, e.target.value)}
                              className="w-full bg-slate-900 border border-slate-800 rounded-lg py-1.5 px-3 text-[10px] text-white placeholder:text-slate-700 focus:outline-none focus:border-indigo-600 transition-colors font-mono"
                             />
                          </div>
                        )}

                        {ch.status === 'processing' && <div className="h-1 bg-slate-950 rounded-full overflow-hidden mb-4"><div className="h-full bg-indigo-500 animate-pulse transition-all" style={{ width: `${ch.progress}%` }} /></div>}
                        
                        <div className="flex gap-2">
                          <button 
                            onClick={() => startReading(ch)} 
                            disabled={ch.images.length === 0}
                            className={`flex-1 py-2 rounded-xl flex items-center justify-center gap-2 text-[8px] font-black uppercase transition-all ${ch.status === 'done' ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'bg-slate-900 border border-slate-700 text-slate-400 hover:text-white disabled:opacity-30'}`}
                          >
                            <BookOpen size={12} /> {ch.status === 'done' ? 'Open Reader' : 'Live Preview'}
                          </button>
                          
                          {ch.status !== 'done' && ch.status !== 'processing' && (
                            <label className="cursor-pointer flex-1">
                              <div className={`py-2 border rounded-xl flex items-center justify-center gap-2 text-[8px] font-black uppercase tracking-widest transition-all ${ch.images.length > 0 ? 'bg-slate-800 border-slate-700 text-slate-500' : 'bg-indigo-600/10 border-indigo-500/30 text-indigo-400'}`}>
                                <Plus size={12} /> {ch.images.length > 0 ? 'Replace' : 'Upload'}
                              </div>
                              <input type="file" multiple accept="image/*" className="hidden" onChange={e => handleSlotUpload(e, ch.id)} />
                            </label>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              </div>

              {/* Hub Height Resize Handle */}
              <div 
                className="h-6 -my-3 w-full cursor-row-resize flex items-center justify-center group z-20"
                onMouseDown={(e) => {
                  isResizingHub.current = true;
                  document.body.style.cursor = 'row-resize';
                  e.preventDefault();
                }}
              >
                <div className="h-1 w-24 bg-slate-800 rounded-full group-hover:bg-indigo-500 transition-colors" />
              </div>

              <div className="flex-1 flex flex-col bg-slate-900/60 border border-slate-800 rounded-[2.5rem] overflow-hidden shadow-2xl backdrop-blur-md">
                <div className="h-12 border-b border-slate-800 px-6 flex items-center justify-between bg-slate-900/40"><div className="flex items-center gap-2"><TerminalIcon size={14} className="text-emerald-400" /><span className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400">Concurrency Monitor</span></div></div>
                <div className="flex-1 overflow-y-auto p-6 font-mono text-[10px] space-y-1.5 scroll-smooth no-scrollbar">
                    {logs.map(log => (<div key={log.id} className="flex gap-3 items-start animate-in slide-in-from-left-2 duration-200"><span className="text-slate-700 shrink-0">[{log.timestamp.toLocaleTimeString()}]</span><span className={`font-bold shrink-0 min-w-[65px] ${log.level === 'success' ? 'text-emerald-400' : log.level === 'warning' ? 'text-amber-400' : log.level === 'error' ? 'text-rose-400' : log.level === 'ai' ? 'text-purple-400' : 'text-indigo-400'}`}>{log.level.toUpperCase()}</span><span className="text-slate-300">{log.message}</span></div>))}
                    <div ref={terminalEndRef} />
                </div>
              </div>
            </>
          ) : (
             <div className="flex-1 flex flex-col items-center justify-center bg-slate-900/60 border border-slate-800 rounded-[2.5rem] p-10 text-center">
               <div className="max-w-2xl w-full space-y-8 flex flex-col h-full overflow-hidden">
                 <div className="shrink-0">
                   <div className="w-20 h-20 bg-indigo-600/20 rounded-3xl flex items-center justify-center mx-auto text-indigo-400 mb-6">
                     <BookOpen size={40} />
                   </div>
                   <h2 className="text-2xl font-black uppercase tracking-[0.2em]">Active Archives</h2>
                   <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-2">Use Arrows to Navigate • Enter to Open</p>
                 </div>
                 
                 <div className="flex-1 overflow-y-auto pr-4 space-y-4 scroll-smooth">
                   {chapters.filter(c => c.images.length > 0).length === 0 ? (
                     <div className="py-20 border-2 border-dashed border-slate-800 rounded-[2rem] flex flex-col items-center justify-center text-slate-700 opacity-20">
                       <Sparkles size={48} className="mb-4" />
                       <p className="text-xs font-black uppercase tracking-widest text-center">No Chapters Ready</p>
                     </div>
                   ) : (
                     chapters.filter(c => c.images.length > 0).map((c, idx) => {
                       const isSelected = selectedChapterIndex === idx;
                       return (
                         <button 
                           key={c.id} 
                           ref={isSelected ? selectedChapterRef : null}
                           onClick={() => startReading(c)} 
                           onMouseEnter={() => setSelectedChapterIndex(idx)}
                           className={`w-full p-6 border-2 rounded-[2rem] flex items-center justify-between transition-all duration-300 group ${isSelected ? 'bg-indigo-600 border-indigo-500 shadow-[0_0_30px_rgba(79,70,229,0.3)] scale-[1.02] text-white' : 'bg-slate-800/40 border-slate-800 hover:border-slate-700 text-slate-300'}`}
                         >
                           <div className="text-left overflow-hidden">
                             <p className={`text-sm font-black uppercase truncate ${isSelected ? 'text-white' : 'text-slate-100'}`}>{c.name}</p>
                             <p className={`text-[10px] uppercase font-bold ${isSelected ? 'text-indigo-200' : 'text-slate-500'}`}>{c.notes.length} Entities • {c.images.length} Pages</p>
                           </div>
                           <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${isSelected ? 'bg-white text-indigo-600' : 'bg-slate-900 text-slate-600 group-hover:text-indigo-400'}`}>
                             <ChevronRight size={20} />
                           </div>
                         </button>
                       );
                     })
                   )}
                 </div>
               </div>
             </div>
          )}
        </section>
      </main>

      {activeReaderChapter && viewMode === 'reader' && (
        <ReaderView 
          chapter={activeReaderChapter} 
          onClose={() => { setViewMode('hub'); setActiveReaderChapter(null); }} 
          onUpdateNotes={handleUpdateNotes}
          pageUrls={pageUrls}
          setPageUrls={setPageUrls}
          onSwitchChapter={handleSwitchChapter}
          hasPrevChapter={chapters.filter(c => c.images.length > 0).findIndex(c => c.id === activeReaderChapter.id) > 0}
          hasNextChapter={chapters.filter(c => c.images.length > 0).findIndex(c => c.id === activeReaderChapter.id) < chapters.filter(c => c.images.length > 0).length - 1}
        />
      )}
    </div>
  );
};

export default App;
