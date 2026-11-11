
import React, { useRef, useState, useEffect } from 'react';
import { Play, Pause, Square, ZoomIn, ZoomOut, Upload, Activity, SkipBack, Repeat, Save, Eye, EyeOff, ChevronUp, ChevronDown, RefreshCw, Trash2, Undo2, Redo2, Plus, Scissors, FileText, Download, FolderOpen, Wand2, SlidersHorizontal, Type, Headphones, Magnet, Merge, ArrowLeftRight } from 'lucide-react';

interface ControlsProps {
  isPlaying: boolean;
  isLooping: boolean;
  onPlayPause: () => void;
  onStop: () => void;
  onRewind: () => void;
  onToggleLoop: () => void;
  
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFileLoad: (file: File) => void;
  onExtractPitch: () => void;
  
  // File Operations
  onSaveProject: () => void;
  onSaveAsProject: () => void;
  onLoadProject: (file: File) => void;
  onExportPitchCSV: () => void;
  onExportNotesCSV: () => void;
  onExportSVL: () => void;
  onImportPitch: (file: File) => void;
  onImportNotes: (file: File) => void;

  isAnalyzing: boolean;
  isRecalculating?: boolean;
  hasData: boolean;
  fileName: string | null;

  // Correction Mode
  selectionActive: boolean;
  showCandidates: boolean;
  onToggleCandidates: () => void;
  onShiftUp: () => void;
  onShiftDown: () => void;
  onRecalculateCandidates: () => void;
  onDeletePitch: () => void;
  onSnapPitch: () => void;
  snapMaxRatio: number;
  onSnapMaxRatioChange: (r: number) => void;

  // Note Tools
  onCreateNote: () => void;
  onDeleteNote: () => void;
  onSplitNote: () => void;
  onMergeNotes: () => void;
  onCloseGaps: () => void;
  onAutoSegment: () => void;
  onStartTextEntry: () => void;
  textEntryActive?: boolean;
  onLoadTextAudio: (file: File) => void;
  textAudioName?: string | null;
  onExportNotesTSV: () => void;
  isSegmenting?: boolean;
  segParams: { pruneSec: number; observationTrust: number; method: 'hmm' | 'stable'; pitchThreshold: number; closeGapSec: number };
  onSegParamsChange: (p: { pruneSec: number; observationTrust: number; method: 'hmm' | 'stable'; pitchThreshold: number; closeGapSec: number }) => void;

  // Undo/Redo
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

const Controls: React.FC<ControlsProps> = ({
  isPlaying,
  isLooping,
  onPlayPause,
  onStop,
  onRewind,
  onToggleLoop,
  onZoomIn,
  onZoomOut,
  onFileLoad,
  onExtractPitch,
  onSaveProject,
  onSaveAsProject,
  onLoadProject,
  onExportPitchCSV,
  onExportNotesCSV,
  onExportSVL,
  onImportPitch,
  onImportNotes,
  isAnalyzing,
  isRecalculating = false,
  hasData,
  fileName,
  selectionActive,
  showCandidates,
  onToggleCandidates,
  onShiftUp,
  onShiftDown,
  onRecalculateCandidates,
  onDeletePitch,
  onSnapPitch,
  snapMaxRatio,
  onSnapMaxRatioChange,
  onCreateNote,
  onDeleteNote,
  onSplitNote,
  onMergeNotes,
  onCloseGaps,
  onAutoSegment,
  onStartTextEntry,
  textEntryActive = false,
  onLoadTextAudio,
  textAudioName = null,
  onExportNotesTSV,
  isSegmenting = false,
  segParams,
  onSegParamsChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textAudioInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const importPitchRef = useRef<HTMLInputElement>(null);
  const importNotesRef = useRef<HTMLInputElement>(null);
  
  const [showFileMenu, setShowFileMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [showSegSettings, setShowSegSettings] = useState(false);
  const segRef = useRef<HTMLDivElement>(null);

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowFileMenu(false);
      }
      if (segRef.current && !segRef.current.contains(event.target as Node)) {
        setShowSegSettings(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleAction = (action: () => void, e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur();
    action();
  };

  const handleLoadClick = async () => {
    setShowFileMenu(false);
    if ('showOpenFilePicker' in window) {
      try {
        const pickerOpts = {
          id: 'tony-web-audio-load', 
          startIn: 'downloads',
          types: [
            {
              description: 'Audio Files',
              accept: {
                'audio/*': ['.wav', '.mp3', '.ogg', '.flac', '.m4a']
              }
            },
          ],
          excludeAcceptAllOption: true,
          multiple: false
        };
        // @ts-ignore
        const [fileHandle] = await window.showOpenFilePicker(pickerOpts);
        const file = await fileHandle.getFile();
        onFileLoad(file);
      } catch (err) {
        console.debug('File picker cancelled or failed', err);
      }
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
        onFileLoad(e.target.files[0]);
    }
  };

  return (
    <div className="h-16 bg-gray-100 border-b border-gray-300 flex items-center px-4 justify-between select-none text-gray-800 z-50">
      
      {/* Left Group: Transport & Edit */}
      <div className="flex items-center gap-4">
        
        {/* FILE MENU */}
        <div className="relative" ref={menuRef}>
            <button 
                onClick={() => setShowFileMenu(!showFileMenu)}
                className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm font-semibold transition-colors border focus:outline-none ${showFileMenu ? 'bg-gray-200 border-gray-400' : 'bg-white border-gray-300 hover:bg-gray-50'}`}
            >
                <FolderOpen size={18} />
                <span>File</span>
            </button>

            {showFileMenu && (
                <div className="absolute top-full left-0 mt-1 w-64 bg-white border border-gray-200 rounded-md shadow-xl py-1 z-50 text-sm">
                    <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Project</div>
                    <button onClick={handleLoadClick} className="w-full text-left px-4 py-2 hover:bg-blue-50 flex items-center gap-2">
                        <Upload size={14} /> Open Audio...
                    </button>
                    <button onClick={() => { textAudioInputRef.current?.click(); setShowFileMenu(false); }} disabled={!hasData} className="w-full text-left px-4 py-2 hover:bg-blue-50 flex items-center gap-2 disabled:opacity-50" title="Second recording (e.g. headset mic) used for listening while entering note texts">
                        <Headphones size={14} /> <span className="truncate">{textAudioName ? `Text Audio: ${textAudioName}` : 'Load Text Audio (Headset)...'}</span>
                    </button>
                    <button onClick={() => { onSaveProject(); setShowFileMenu(false); }} disabled={!hasData} className="w-full text-left px-4 py-2 hover:bg-blue-50 flex items-center gap-2 disabled:opacity-50">
                        <Save size={14} /> Save Project (.json)
                    </button>
                    <button onClick={() => { onSaveAsProject(); setShowFileMenu(false); }} disabled={!hasData} className="w-full text-left px-4 py-2 hover:bg-blue-50 flex items-center gap-2 disabled:opacity-50">
                        <Save size={14} /> Save Project As...
                    </button>
                    <button onClick={() => { projectInputRef.current?.click(); setShowFileMenu(false); }} className="w-full text-left px-4 py-2 hover:bg-blue-50 flex items-center gap-2">
                        <FolderOpen size={14} /> Load Project...
                    </button>

                    <div className="border-t border-gray-100 my-1"></div>
                    <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Export</div>
                    
                    <button onClick={() => { onExportPitchCSV(); setShowFileMenu(false); }} disabled={!hasData} className="w-full text-left px-4 py-2 hover:bg-blue-50 flex items-center gap-2 disabled:opacity-50">
                        <FileText size={14} /> Export Pitch (CSV)
                    </button>
                    <button onClick={() => { onExportNotesCSV(); setShowFileMenu(false); }} disabled={!hasData} className="w-full text-left px-4 py-2 hover:bg-blue-50 flex items-center gap-2 disabled:opacity-50">
                        <FileText size={14} /> Export Notes (CSV)
                    </button>
                    <button onClick={() => { onExportNotesTSV(); setShowFileMenu(false); }} disabled={!hasData} className="w-full text-left px-4 py-2 hover:bg-blue-50 flex items-center gap-2 disabled:opacity-50">
                        <FileText size={14} /> Export Notes + Text (Tony .txt)
                    </button>
                    <button onClick={() => { onExportSVL(); setShowFileMenu(false); }} disabled={!hasData} className="w-full text-left px-4 py-2 hover:bg-blue-50 flex items-center gap-2 disabled:opacity-50">
                        <Activity size={14} /> Export SVL (Sonic Visualiser)
                    </button>

                    <div className="border-t border-gray-100 my-1"></div>
                    <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Import</div>
                    
                    <button onClick={() => { importPitchRef.current?.click(); setShowFileMenu(false); }} className="w-full text-left px-4 py-2 hover:bg-blue-50 flex items-center gap-2">
                        <Download size={14} /> Import Pitch (CSV)
                    </button>
                    <button onClick={() => { importNotesRef.current?.click(); setShowFileMenu(false); }} className="w-full text-left px-4 py-2 hover:bg-blue-50 flex items-center gap-2">
                        <Download size={14} /> Import Notes (CSV / Tony .txt)
                    </button>
                </div>
            )}
            
            {/* Hidden Inputs for File Operations */}
            <input 
                ref={fileInputRef}
                type="file" 
                accept="audio/*" 
                onChange={handleInputChange} 
                className="hidden" 
            />
            <input 
                ref={textAudioInputRef}
                type="file" 
                accept="audio/*" 
                onChange={(e) => { if(e.target.files?.[0]) onLoadTextAudio(e.target.files[0]); e.target.value = ''; }} 
                className="hidden" 
            />
            <input 
                ref={projectInputRef}
                type="file" 
                accept=".json,.tonyweb" 
                onChange={(e) => { if(e.target.files?.[0]) onLoadProject(e.target.files[0]); e.target.value = ''; }} 
                className="hidden" 
            />
             <input 
                ref={importPitchRef}
                type="file" 
                accept=".csv" 
                onChange={(e) => { if(e.target.files?.[0]) onImportPitch(e.target.files[0]); e.target.value = ''; }} 
                className="hidden" 
            />
             <input 
                ref={importNotesRef}
                type="file" 
                accept=".csv,.txt,.tsv" 
                onChange={(e) => { if(e.target.files?.[0]) onImportNotes(e.target.files[0]); e.target.value = ''; }} 
                className="hidden" 
            />
        </div>

        {/* Transport */}
        <div className="flex items-center gap-1 bg-gray-200 rounded-lg p-1 border border-gray-300 relative">
          <button 
            onClick={(e) => handleAction(onRewind, e)}
            className="p-2 hover:bg-gray-300 rounded text-gray-700 transition-colors focus:outline-none"
            title="Rewind to Start"
          >
            <SkipBack size={20} />
          </button>
          
          <button 
            onClick={(e) => handleAction(onPlayPause, e)}
            className="p-2 hover:bg-gray-300 rounded text-gray-700 transition-colors focus:outline-none"
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button 
            onClick={(e) => handleAction(onStop, e)}
            className="p-2 hover:bg-gray-300 rounded text-gray-700 transition-colors focus:outline-none"
            title="Stop"
          >
            <Square size={20} />
          </button>
          <div className="w-px h-6 bg-gray-300 mx-1"></div>
          <button 
            onClick={(e) => handleAction(onToggleLoop, e)}
            className={`p-2 rounded transition-colors focus:outline-none ${isLooping ? 'bg-blue-200 text-blue-800 hover:bg-blue-300' : 'hover:bg-gray-300 text-gray-700'}`}
            title="Loop Selection"
          >
            <Repeat size={20} />
          </button>
        </div>

        {/* Global Undo/Redo */}
        <div className="flex items-center gap-1 bg-gray-200 rounded-lg p-1 border border-gray-300">
             <button 
                onClick={(e) => handleAction(onUndo, e)}
                disabled={!canUndo}
                className={`p-2 rounded transition-colors focus:outline-none ${!canUndo ? 'text-gray-400 cursor-not-allowed' : 'hover:bg-gray-300 text-gray-700'}`}
                title="Undo (Ctrl+Z)"
             >
                <Undo2 size={18} />
             </button>
             <button 
                onClick={(e) => handleAction(onRedo, e)}
                disabled={!canRedo}
                className={`p-2 rounded transition-colors focus:outline-none ${!canRedo ? 'text-gray-400 cursor-not-allowed' : 'hover:bg-gray-300 text-gray-700'}`}
                title="Redo (Ctrl+Shift+Z)"
             >
                <Redo2 size={18} />
             </button>
        </div>

        {/* Note Tools */}
        <div className={`flex flex-col items-center justify-center gap-0 bg-gray-200 rounded-lg px-2 py-0.5 border border-gray-300`}>
            <div className="flex items-center gap-1">
                <button 
                    onClick={(e) => handleAction(onStartTextEntry, e)}
                    disabled={!hasData}
                    className={`p-1.5 rounded transition-colors focus:outline-none disabled:text-gray-400 ${textEntryActive ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-blue-100 hover:text-blue-700'}`}
                    title="Enter note texts (T): jumps to the first note without text, plays it in a loop; Enter = next note"
                >
                    <Type size={18} />
                </button>
                <div className="relative flex items-center" ref={segRef}>
                    <button 
                        onClick={(e) => handleAction(onAutoSegment, e)}
                        disabled={!hasData || isSegmenting}
                        className="p-1.5 hover:bg-blue-100 hover:text-blue-700 rounded text-gray-700 transition-colors focus:outline-none disabled:text-gray-400"
                        title={selectionActive ? "Auto-Segment Notes in Selection" : "Auto-Segment Notes (whole file)"}
                    >
                        <Wand2 size={18} className={isSegmenting ? "animate-pulse" : ""} />
                    </button>
                    <button 
                        onClick={(e) => { e.currentTarget.blur(); setShowSegSettings(v => !v); }}
                        className={`p-0.5 rounded text-gray-500 hover:bg-gray-300 focus:outline-none ${showSegSettings ? 'bg-gray-300' : ''}`}
                        title="Segmentation settings"
                    >
                        <SlidersHorizontal size={12} />
                    </button>
                    {showSegSettings && (
                        <div className="absolute top-full left-0 mt-2 w-64 bg-white border border-gray-300 rounded-md shadow-lg p-3 z-50 text-xs text-gray-700">
                            <div className="font-semibold mb-2">Auto-segmentation</div>
                            <label className="block mb-3">
                                <span>Method</span>
                                <select className="w-full border border-gray-300 rounded px-1 py-0.5 mt-0.5" value={segParams.method}
                                    onChange={(e) => onSegParamsChange({ ...segParams, method: e.target.value as 'hmm' | 'stable' })}>
                                    <option value="hmm">HMM (Tony-like)</option>
                                    <option value="stable">Stable regions (morphological)</option>
                                </select>
                            </label>
                            <label className="block mb-3">
                                <div className="flex justify-between"><span>Min. note length</span><span className="font-mono">{segParams.pruneSec.toFixed(2)} s</span></div>
                                <input type="range" min={0.05} max={0.4} step={0.01} value={segParams.pruneSec} className="w-full"
                                    onChange={(e) => onSegParamsChange({ ...segParams, pruneSec: parseFloat(e.target.value) })} />
                            </label>
                            {segParams.method === 'stable' ? (<>
                            <label className="block mb-3">
                                <div className="flex justify-between"><span>Stable fraction</span><span className="font-mono">{segParams.pitchThreshold.toFixed(2)}</span></div>
                                <input type="range" min={0.3} max={0.95} step={0.01} value={segParams.pitchThreshold} className="w-full"
                                    onChange={(e) => onSegParamsChange({ ...segParams, pitchThreshold: parseFloat(e.target.value) })} />
                                <div className="flex justify-between text-gray-400"><span>stricter</span><span>more tolerant</span></div>
                            </label>
                            </>) : (
                            <label className="block mb-2">
                                <div className="flex justify-between"><span>Sensitivity</span><span className="font-mono">{segParams.observationTrust.toFixed(2)}</span></div>
                                <input type="range" min={0.3} max={1.6} step={0.05} value={segParams.observationTrust} className="w-full"
                                    onChange={(e) => onSegParamsChange({ ...segParams, observationTrust: parseFloat(e.target.value) })} />
                                <div className="flex justify-between text-gray-400"><span>fewer notes</span><span>more notes</span></div>
                            </label>
                            )}
                            <div className="border-t border-gray-200 my-2"></div>
                            <label className="block mb-2">
                                <div className="flex justify-between"><span>Close gaps up to</span><span className="font-mono">{segParams.closeGapSec.toFixed(2)} s</span></div>
                                <input type="range" min={0.05} max={0.5} step={0.01} value={segParams.closeGapSec} className="w-full"
                                    onChange={(e) => onSegParamsChange({ ...segParams, closeGapSec: parseFloat(e.target.value) })} />
                                <div className="text-gray-400">Used by the "Close gaps" button (selection only).</div>
                            </label>
                            <div className="text-gray-400">With a selection, only the selected region is re-segmented.</div>
                        </div>
                    )}
                </div>
                <div className="w-px h-5 bg-gray-300 mx-0.5"></div>
                <button 
                    onClick={(e) => handleAction(onCreateNote, e)}
                    disabled={!selectionActive}
                    className="p-1.5 hover:bg-blue-100 hover:text-blue-700 rounded text-gray-700 transition-colors focus:outline-none disabled:text-gray-400"
                    title="Create Note (=)"
                >
                    <Plus size={18} />
                </button>
                <button 
                    onClick={(e) => handleAction(onSplitNote, e)}
                    disabled={!hasData}
                    className="p-1.5 hover:bg-blue-100 hover:text-blue-700 rounded text-gray-700 transition-colors focus:outline-none disabled:text-gray-400"
                    title="Split Note at Cursor (/)"
                >
                    <Scissors size={18} />
                </button>
                <button 
                    onClick={(e) => handleAction(onMergeNotes, e)}
                    disabled={!hasData}
                    className="p-1.5 hover:bg-blue-100 hover:text-blue-700 rounded text-gray-700 transition-colors focus:outline-none disabled:text-gray-400"
                    title="Merge Notes (-): all notes in the selection, or the selected note / the note at the cursor with the next note"
                >
                    <Merge size={18} />
                </button>
                <button 
                    onClick={(e) => handleAction(onCloseGaps, e)}
                    disabled={!selectionActive}
                    className="p-1.5 hover:bg-blue-100 hover:text-blue-700 rounded text-gray-700 transition-colors focus:outline-none disabled:text-gray-400"
                    title="Close gaps between notes in the selection (max. gap length: see segmentation settings)"
                >
                    <ArrowLeftRight size={18} />
                </button>
                <button 
                    onClick={(e) => handleAction(onDeleteNote, e)}
                    disabled={!selectionActive}
                    className="p-1.5 hover:bg-red-100 hover:text-red-700 rounded text-gray-700 transition-colors focus:outline-none disabled:text-gray-400"
                    title="Delete Note (Backspace/Delete)"
                >
                    <Trash2 size={18} />
                </button>
            </div>
            <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider leading-none pb-0.5">Notes</span>
        </div>

        {/* Correction Tools (f0) */}
        <div className={`flex flex-col items-center justify-center gap-0 bg-gray-200 rounded-lg px-2 py-0.5 border border-gray-300 transition-opacity ${selectionActive ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
             <div className="flex items-center gap-1">
                <button 
                    onClick={(e) => handleAction(onToggleCandidates, e)}
                    className={`p-1.5 rounded transition-colors focus:outline-none ${showCandidates ? 'bg-yellow-200 text-yellow-800' : 'hover:bg-gray-300 text-gray-700'}`}
                    title="Show Candidates (Shift+C)"
                >
                    {showCandidates ? <Eye size={18} /> : <EyeOff size={18} />}
                </button>
                <div className="w-px h-5 bg-gray-300 mx-0.5"></div>
                <button 
                    onClick={(e) => handleAction(onShiftUp, e)}
                    disabled={!selectionActive}
                    className="p-1.5 hover:bg-gray-300 rounded text-gray-700 transition-colors focus:outline-none disabled:text-gray-400"
                    title="Pick Next Candidate Above (Cmd+Up)"
                >
                    <ChevronUp size={18} />
                </button>
                <button 
                    onClick={(e) => handleAction(onShiftDown, e)}
                    disabled={!selectionActive}
                    className="p-1.5 hover:bg-gray-300 rounded text-gray-700 transition-colors focus:outline-none disabled:text-gray-400"
                    title="Pick Next Candidate Below (Cmd+Down)"
                >
                    <ChevronDown size={18} />
                </button>
                <div className="w-px h-5 bg-gray-300 mx-0.5"></div>
                <button 
                    onClick={(e) => handleAction(onRecalculateCandidates, e)}
                    disabled={!selectionActive || isRecalculating}
                    className={`p-1.5 hover:bg-gray-300 rounded text-gray-700 transition-colors focus:outline-none disabled:text-gray-400`}
                    title="Recalculate Candidates (Deep Search)"
                >
                    <RefreshCw size={18} className={isRecalculating ? "animate-spin" : ""} />
                </button>
                <button 
                    onClick={(e) => handleAction(onSnapPitch, e)}
                    disabled={!selectionActive || isRecalculating}
                    className="p-1.5 hover:bg-gray-300 rounded text-gray-700 transition-colors focus:outline-none disabled:text-gray-400"
                    title="Snap pitch in selection to the strongest spectral line (search range set at right)"
                >
                    <Magnet size={18} />
                </button>
                <select
                    value={snapMaxRatio}
                    onChange={(e) => { onSnapMaxRatioChange(parseFloat(e.target.value)); e.currentTarget.blur(); }}
                    className="text-[11px] bg-white border border-gray-300 rounded px-0.5 py-0.5 focus:outline-none"
                    title="Snap search range: highest line considered, relative to the detected pitch"
                >
                    <option value={1.6}>≤ ×1.5 (5th)</option>
                    <option value={2.1}>≤ ×2 (octave)</option>
                    <option value={3.2}>≤ ×3</option>
                    <option value={4.2}>≤ ×4</option>
                </select>
                <button 
                    onClick={(e) => handleAction(onDeletePitch, e)}
                    disabled={!selectionActive}
                    className="p-1.5 hover:bg-red-100 hover:text-red-700 rounded text-gray-700 transition-colors focus:outline-none disabled:text-gray-400"
                    title="Delete Pitch in Selection"
                >
                    <Trash2 size={18} />
                </button>
            </div>
            <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider leading-none pb-0.5">Pitch Correction</span>
        </div>

        <div className="h-8 w-px bg-gray-300 mx-2"></div>
        
        <div className="text-xs text-gray-500 font-mono truncate max-w-[120px]" title={fileName || ""}>
            {fileName || "No Audio"}
        </div>

        <button 
            onClick={(e) => handleAction(onExtractPitch, e)}
            disabled={isAnalyzing || !fileName}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors shadow-sm border focus:outline-none ${
                isAnalyzing || !fileName 
                ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed' 
                : 'bg-white hover:bg-gray-50 text-gray-800 border-gray-300'
            }`}
        >
            <Activity size={16} className={isAnalyzing || !fileName ? "text-gray-400" : "text-blue-600"} />
            {isAnalyzing ? "Analyzing..." : "Extract Pitch"}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button 
            onClick={(e) => handleAction(onZoomOut, e)}
            className="p-2 hover:bg-gray-200 rounded-full transition-colors text-gray-600 focus:outline-none"
            title="Zoom Out"
        >
            <ZoomOut size={20} />
        </button>
        <button 
            onClick={(e) => handleAction(onZoomIn, e)}
            className="p-2 hover:bg-gray-200 rounded-full transition-colors text-gray-600 focus:outline-none"
            title="Zoom In"
        >
            <ZoomIn size={20} />
        </button>
      </div>
    </div>
  );
};

export default Controls;
