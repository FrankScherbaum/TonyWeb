
import { useState, useEffect, useCallback, useRef, useLayoutEffect, useMemo } from 'react';
import Controls from './components/Controls';
import WaveformNavigator from './components/WaveformNavigator';
import PitchVisualizer from './components/PitchVisualizer';
import Mixer from './components/Mixer';
import { audioService } from './services/audioService';
import { extractPitch, YIN_HOP_SIZE, YIN_WINDOW_SIZE } from './services/yin';
import { extractPitchEckf } from './services/eckfPitch';
import { generateSpectrogram } from './services/spectrogram';
import { segmentNotes, DEFAULT_SEGMENTATION_PARAMS } from './services/noteSegmentation';
import { segmentStableRegions, DEFAULT_STABLE_REGION_PARAMS } from './services/stableRegionSegmentation';
import { generateProjectJSON, generatePitchCSV, generateNotesCSV, generateNotesTSV, generateSVL, parseProjectJSON, parseCSV } from './services/exportService';
import { MixerState, PitchFrame, Note, SpectrogramData, AudioSource } from './types';
import { useUndoRedo } from './hooks/useUndoRedo';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { calculateMedianPitch, snapTime, splitNote, resizeNoteWithPush, mergeNotes, inheritNoteTexts, closeNoteGaps, setSnapHop, estimateHopSamples } from './utils/noteUtils';
import { suggestNoteTexts } from './utils/textSuggest';
import { freqToY } from './utils/renderUtils';
import { snapPitchFrames, DEFAULT_SNAP_PARAMS } from './services/spectralSnap';
import { sliceAudioBuffer } from './utils/audioUtils';
import { X } from 'lucide-react';
import { saveAutosave, loadAutosave, clearAutosave } from './services/autosave';

function App() {
  // --- Audio & Playback State ---
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLooping, setIsLooping] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);

  // Selection: [start, end]
  const [selectionRange, setSelectionRange] = useState<[number, number] | null>(null);

  // Note Selection (for Pitch Editing)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  // --- Second recording (headset) + text entry ---
  const [textAudio, setTextAudio] = useState<{ buffer: AudioBuffer; name: string } | null>(null);
  const [textAudioOffset, setTextAudioOffset] = useState(0);
  const [audioSource, setAudioSource] = useState<AudioSource>('main');
  const [textEntryActive, setTextEntryActive] = useState(false);
  const [textDraft, setTextDraft] = useState('');
  const textInputRef = useRef<HTMLInputElement>(null);
  const [pitchInputValue, setPitchInputValue] = useState("");

  // --- Analysis & History via Hook ---
  // History stores { pitchData, notes }
  const { 
    state: analysis, 
    commit: commitHistory, 
    undo, 
    redo, 
    reset: resetHistory, 
    canUndo, 
    canRedo 
  } = useUndoRedo<{pitchData: PitchFrame[], notes: Note[]}>({ pitchData: [], notes: [] });

  // Separate loading state (not part of history)
  const [analysisStatus, setAnalysisStatus] = useState({ isAnalyzing: false, progress: 0 });
  const [isRecalculating, setIsRecalculating] = useState(false);

  // Automatic note segmentation
  const [isSegmenting, setIsSegmenting] = useState(false);
  const [segmentProgress, setSegmentProgress] = useState(0);
  const [segParams, setSegParams] = useState({
    pruneSec: DEFAULT_SEGMENTATION_PARAMS.pruneSec,
    observationTrust: DEFAULT_SEGMENTATION_PARAMS.observationTrust,
    method: 'hmm' as 'hmm' | 'stable',
    pitchThreshold: DEFAULT_STABLE_REGION_PARAMS.pitchThreshold,
    closeGapSec: 0.3,
  });

  // Correction Mode State
  const [showCandidates, setShowCandidates] = useState(false);

  // --- Spectrogram State ---
  const [spectrogramData, setSpectrogramData] = useState<SpectrogramData | null>(null);
  const [showSpectrogram, setShowSpectrogram] = useState(false);

  // --- Visual Visibility State ---
  const [showPitch, setShowPitch] = useState(true);
  const [showNotes, setShowNotes] = useState(true);

  // --- Mixer State ---
  const [mixerState, setMixerState] = useState<MixerState>({
    originalEnabled: true, originalVolume: 1.0,
    pitchEnabled: true, pitchVolume: 0.6,
    notesEnabled: true, notesVolume: 0.6
  });

  // --- View State ---
  const [zoom, setZoom] = useState(100); 
  const [viewStartTime, setViewStartTime] = useState(0); 
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  
  // --- Modals ---
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveModalConfig, setSaveModalConfig] = useState<{content: string, defaultName: string, type: string} | null>(null);
  const [saveFileNameInput, setSaveFileNameInput] = useState("");
  const [locateModalOpen, setLocateModalOpen] = useState(false);
  const [pendingProjectData, setPendingProjectData] = useState<any | null>(null);
  const [projectHandle, setProjectHandle] = useState<any | null>(null);
  const [restoreOffer, setRestoreOffer] = useState<{ data: any; savedAt: number } | null>(null);
  // Pitch tracker settings: time step (hop) and analysis window in samples
  const [pitchHop, setPitchHop] = useState(YIN_HOP_SIZE);
  const [pitchWindow, setPitchWindow] = useState(YIN_WINDOW_SIZE);
  const [pitchMethod, setPitchMethod] = useState<'pyin' | 'eckf'>('pyin');
  const [eckfC, setEckfC] = useState(6);
  
  const animationFrameRef = useRef<number | null>(null);
  const fileLocateInputRef = useRef<HTMLInputElement>(null);

  // State Ref for Animation Loop stability
  const stateRef = useRef({
    isPlaying, isLooping, selectionRange, duration, audioBuffer, 
    pitchData: analysis.pitchData, notes: analysis.notes, 
    viewportWidth, zoom, currentTime, fileName, playbackSpeed, viewStartTime
  });

  // Find Selected Note object
  const selectedNote = analysis.notes.find(n => n.id === selectedNoteId);

  useLayoutEffect(() => {
    stateRef.current = {
      isPlaying, isLooping, selectionRange, duration, audioBuffer,
      pitchData: analysis.pitchData, notes: analysis.notes,
      viewportWidth, zoom, currentTime, fileName, playbackSpeed, viewStartTime
    };
  }, [isPlaying, isLooping, selectionRange, duration, audioBuffer, analysis, viewportWidth, zoom, currentTime, fileName, playbackSpeed, viewStartTime]);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    audioService.updateMixer(mixerState);
  }, [mixerState]);

  // Sync pitch input value when selected note pitch changes (drag or selection)
  useEffect(() => {
    if (selectedNote) {
        setPitchInputValue(selectedNote.pitch.toFixed(2));
    }
  }, [selectedNote?.pitch, selectedNote?.id]);

  // End time of a one-shot playback (note preview in text entry); null = normal playback
  const playUntilRef = useRef<number | null>(null);

  // --- Animation Loop ---
  const updateLoop = useCallback(() => {
    const state = stateRef.current;
    if (!state.isPlaying) return;

    const time = audioService.getCurrentTime();

    // One-shot note preview (text entry): stop at its end, no view movement
    if (playUntilRef.current !== null) {
      if (time >= playUntilRef.current) {
        audioService.stop();
        playUntilRef.current = null;
        setIsPlaying(false);
        return;
      }
      setCurrentTime(time);
      animationFrameRef.current = requestAnimationFrame(updateLoop);
      return;
    }
    
    // Check Loop
    if (state.isLooping && state.selectionRange) {
      if (time >= state.selectionRange[1]) {
        const loopDuration = state.selectionRange[1] - state.selectionRange[0];
        audioService.stop(); 
        try {
            audioService.play(
                state.audioBuffer!, 
                state.pitchData, 
                state.notes, 
                state.selectionRange[0], 
                loopDuration, 
                state.playbackSpeed // Pass speed
            );
        } catch(e) { console.error("Loop restart failed", e); }
        
        setCurrentTime(state.selectionRange[0]);
        // Center view on loop start
        const viewDuration = state.viewportWidth / state.zoom;
        setViewStartTime(Math.max(0, state.selectionRange[0] - viewDuration / 2));
        
        animationFrameRef.current = requestAnimationFrame(updateLoop);
        return;
      }
    }

    // Check End
    if (time >= state.duration && state.duration > 0) {
      setIsPlaying(false);
      audioService.stop();
      setCurrentTime(state.isLooping && !state.selectionRange ? 0 : state.duration);
    } else {
      setCurrentTime(time);
      // Continuous View Centering
      const viewDuration = state.viewportWidth / state.zoom;
      setViewStartTime(Math.max(0, time - viewDuration / 2));
      animationFrameRef.current = requestAnimationFrame(updateLoop);
    }
  }, []);

  useEffect(() => {
    if (isPlaying) {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = requestAnimationFrame(updateLoop);
    } else {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    }
    return () => { if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current); };
  }, [isPlaying, updateLoop]);


  // --- Logic Handlers ---

  // Time step (samples) of the pitch track currently loaded - used for snapping and the frame grid
  const dataHop = useMemo(
    () => (audioBuffer ? estimateHopSamples(analysis.pitchData, audioBuffer.sampleRate) : YIN_HOP_SIZE),
    [analysis.pitchData, audioBuffer]
  );
  useEffect(() => { setSnapHop(dataHop); }, [dataHop]);

  const runPitchAnalysis = async (buffer: AudioBuffer) => {
    setAnalysisStatus({ isAnalyzing: true, progress: 0 });
    try {
      const channelData = buffer.getChannelData(0);
      const onProg = (p: number) => setAnalysisStatus(prev => ({ ...prev, progress: p }));
      const frames = pitchMethod === 'eckf'
        ? await extractPitchEckf(channelData, buffer.sampleRate, onProg, { hopSize: pitchHop, blockSize: pitchWindow, c: eckfC })
        : await extractPitch(channelData, buffer.sampleRate, onProg, { hopSize: pitchHop, windowSize: pitchWindow });
      setSnapHop(pitchHop);
      setAnalysisStatus({ isAnalyzing: false, progress: 1 });
      resetHistory({ pitchData: frames, notes: [] });

      // Trigger Spectrogram generation in background
      generateSpectrogram(buffer).then(data => {
          setSpectrogramData(data);
      }).catch(e => console.error("Spectrogram generation failed", e));

    } catch (e) {
      console.error(e);
      setAnalysisStatus({ isAnalyzing: false, progress: 0 });
      alert("Analysis failed.");
    }
  };

  const loadAudio = async (file: File) => {
      try {
        const buffer = await audioService.decodeAudio(file);
        setAudioBuffer(buffer);
        setDuration(buffer.duration);
        setFileName(file.name);
        setCurrentTime(0);
        setViewStartTime(0);
        setSelectionRange(null);
        setSelectedNoteId(null);
        setSpectrogramData(null); // Reset spectrogram
        audioService.stop();
        setIsPlaying(false);
        setProjectHandle(null); // Reset project handle on new audio load
        return buffer;
      } catch (err) {
        console.error(err);
        alert("Failed to load audio file.");
        return null;
      }
  };

  const handleFileSelect = useCallback(async (file: File) => {
    if (file) {
      const buffer = await loadAudio(file);
      if (buffer) {
          setTextAudio(null);
          setAudioSource('main');
          setTextAudioOffset(0);
          setAnalysisStatus({ isAnalyzing: false, progress: 0 });
          resetHistory({ pitchData: [], notes: [] });
          // Pitch extraction is started manually ("Extract Pitch"), so that a pitch track can be imported instead.
          generateSpectrogram(buffer).then(data => {
              setSpectrogramData(data);
          }).catch(e => console.error("Spectrogram generation failed", e));
      }
    }
  }, [resetHistory]);

  const handleLocateAudio = useCallback(async (file: File) => {
     if (!file || !pendingProjectData) return;
     const buffer = await loadAudio(file);
     if (buffer) {
         applyProjectData(pendingProjectData, buffer);
         setPendingProjectData(null);
         setLocateModalOpen(false);
         
         // Trigger Spectrogram generation for located audio
         generateSpectrogram(buffer).then(data => {
             setSpectrogramData(data);
         }).catch(e => console.error("Spectrogram generation failed", e));
     }
  }, [pendingProjectData]);

  const handleSelectionChange = useCallback((range: [number, number] | null) => {
    if (range && audioBuffer) {
        const sr = audioBuffer.sampleRate;
        setSelectionRange([snapTime(range[0], sr), snapTime(range[1], sr)]);
        setIsLooping(true);
        // If the user manually changes selection, we might want to clear selected note? 
        // For now keep it to allow complex editing, but could clear setSelectedNoteId(null);
    } else {
        setSelectionRange(range);
        if (!range) {
            setIsLooping(false);
            setSelectedNoteId(null); // Clear selected note on click outside
        }
    }
  }, [audioBuffer]);

  // Helper to start playback using current state ref (avoids closure staleness)
  const playInternal = (state: typeof stateRef.current) => {
      if (!state.audioBuffer) return;
      playUntilRef.current = null;
      
      let startTime = state.currentTime;
      if (Math.abs(state.duration - startTime) < 0.1) startTime = 0;

      let playDuration = undefined;
      if (state.isLooping && state.selectionRange) {
        const [start, end] = state.selectionRange;
        // If cursor is outside loop, jump to start
        if (startTime < start || startTime >= end) startTime = start;
        playDuration = end - startTime;
      } else if (state.isLooping && !state.selectionRange) {
         playDuration = state.duration - startTime;
      }

      // Jump view to center cursor
      const viewDuration = state.viewportWidth / state.zoom;
      setViewStartTime(Math.max(0, startTime - viewDuration / 2));

      audioService.play(
          state.audioBuffer, 
          state.pitchData, 
          state.notes, 
          startTime, 
          playDuration, 
          state.playbackSpeed
      );
      
      // Update React state to reflect playing
      setCurrentTime(startTime); 
      setIsPlaying(true);
  };

  // --- Playback Controls ---
  const handlePlayPause = useCallback(() => {
    const state = stateRef.current;
    if (state.isPlaying) {
      audioService.stop();
      setIsPlaying(false);
    } else {
      try {
        playInternal(state);
      } catch (e) {
        console.error("Playback failed", e);
        setIsPlaying(false);
      }
    }
  }, []);

  const handleStop = useCallback(() => {
    const state = stateRef.current;
    if (!state.audioBuffer) return;
    audioService.stop();
    setIsPlaying(false);
    setCurrentTime(state.isLooping && state.selectionRange ? state.selectionRange[0] : 0);
  }, []);

  const handleSeek = useCallback((time: number) => {
    const state = stateRef.current;
    if (!state.audioBuffer) return;
    
    playUntilRef.current = null;
    const sr = state.audioBuffer.sampleRate;
    let target = snapTime(Math.max(0, Math.min(time, state.duration)), sr);

    if (state.isPlaying) {
      audioService.stop();
      let playDuration = undefined;
      if (state.isLooping && state.selectionRange) {
          if (target >= state.selectionRange[0] && target < state.selectionRange[1]) {
              playDuration = state.selectionRange[1] - target;
          }
      }
      try {
        audioService.play(
            state.audioBuffer, 
            state.pitchData, 
            state.notes, 
            target, 
            playDuration,
            state.playbackSpeed
        );
      } catch (e) { console.error(e); setIsPlaying(false); }
    } 
    setCurrentTime(target);
  }, []);

  const handleRewind = useCallback(() => {
    const state = stateRef.current;
    if (state.isLooping && state.selectionRange) handleSeek(state.selectionRange[0]);
    else handleSeek(0);
  }, [handleSeek]);

  const handleSpeedChange = useCallback((speed: number) => {
    const state = stateRef.current;
    playUntilRef.current = null;
    setPlaybackSpeed(speed);
    
    // If playing, restart with new speed
    if (state.isPlaying && state.audioBuffer) {
        audioService.stop();
        
        let playDuration = undefined;
        let startTime = state.currentTime;
        
        if (state.isLooping && state.selectionRange) {
            playDuration = state.selectionRange[1] - startTime;
        }

        try {
            audioService.play(state.audioBuffer, state.pitchData, state.notes, startTime, playDuration, speed);
            setIsPlaying(true);
        } catch(e) { console.error(e); setIsPlaying(false); }
    }
  }, []);

  // Switch between main recording and headset recording (also while playing)
  useEffect(() => {
    audioService.setAlternateAudio(textAudio?.buffer ?? null, textAudioOffset, audioSource === 'text');
    const st = stateRef.current;
    if (st.isPlaying && st.audioBuffer) handleSeek(st.currentTime);
  }, [textAudio, textAudioOffset, audioSource, handleSeek]);

  const handleLoadTextAudio = useCallback(async (file: File) => {
    let buffer: AudioBuffer;
    try {
      buffer = await audioService.decodeAudio(file);
    } catch (err) {
      console.error(err);
      alert("Failed to load headset audio file.");
      return;
    }
    const main = stateRef.current.duration;
    if (main > 0 && Math.abs(buffer.duration - main) > 1.0) {
      alert(`Note: the headset recording is ${buffer.duration.toFixed(1)} s long, the main recording ${main.toFixed(1)} s. If they were not started together, adjust "Offset" in the mixer.`);
    }
    setTextAudio({ buffer, name: file.name });
    setAudioSource('text');
  }, []);

  const handleExtractPitch = async () => {
    if (!audioBuffer) return;
    if (analysis.pitchData.length > 0 || analysis.notes.length > 0) {
      const ok = window.confirm("Extracting the pitch replaces the current pitch track and removes all notes.\n\nContinue? (Undo is not available for this step.)");
      if (!ok) return;
    }
    runPitchAnalysis(audioBuffer);
  };

  // --- Recalculate Logic ---
  const handleRecalculateCandidates = async () => {
    if (!audioBuffer || !selectionRange) return;
    const [start, end] = selectionRange;
    setIsRecalculating(true);
    try {
        const PADDING = 4096;
        const result = sliceAudioBuffer(audioBuffer, start, end, PADDING);
        
        if (!result) {
            setIsRecalculating(false);
            return;
        }

        const { slice, offset } = result;
        const sr = audioBuffer.sampleRate;
        
        const newFrames = await extractPitch(slice, sr, () => {}, { threshold: 0.95, rmsThreshold: 0, hopSize: dataHop, windowSize: pitchWindow });

        if (!newFrames || newFrames.length === 0) {
            setIsRecalculating(false);
            return;
        }

        const filtered = analysis.pitchData.filter(f => f.timestamp < start || f.timestamp > end);
        
        const validNew = newFrames
            .map(f => ({ ...f, timestamp: f.timestamp + offset }))
            .filter(f => f.timestamp >= start && f.timestamp <= end);

        commitHistory({ pitchData: [...filtered, ...validNew].sort((a, b) => a.timestamp - b.timestamp), notes: analysis.notes });
        setShowCandidates(true);
    } catch (e) { console.error(e); } finally { setIsRecalculating(false); }
  };

  // --- Snap pitch to strongest spectral line (ordinary-microphone recordings) ---
  const [freqRange, setFreqRange] = useState<[number, number]>([50, 5000]);
  const [snapMaxRatio, setSnapMaxRatio] = useState(DEFAULT_SNAP_PARAMS.maxRatio);
  const handleSnapPitch = async () => {
    if (!audioBuffer || !selectionRange) return;
    const [start, end] = selectionRange;
    setIsRecalculating(true);
    try {
      const { frames, changed } = await snapPitchFrames(
        audioBuffer.getChannelData(0), audioBuffer.sampleRate, analysis.pitchData, start, end,
        { ...DEFAULT_SNAP_PARAMS, maxRatio: snapMaxRatio }
      );
      if (changed > 0) commitHistory({ pitchData: frames, notes: analysis.notes });
    } catch (e) { console.error(e); alert("Snap failed."); } finally { setIsRecalculating(false); }
  };

  // --- Save / Export Handlers ---
  const downloadFile = (content: string, name: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => { document.body.removeChild(link); URL.revokeObjectURL(url); }, 250);
  };

  const saveFileAs = useCallback(async (content: string, defaultName: string, type: string, ext: string, desc: string, forceNew = false) => {
      // 1. If we have a project handle and we are Saving (not Save As), overwrite it
      if (!forceNew && projectHandle && type === 'application/json' && 'showSaveFilePicker' in window) {
           try {
               const writable = await projectHandle.createWritable();
               await writable.write(content);
               await writable.close();
               return;
           } catch(err) { console.error("Overwrite failed", err); /* Fallback */ }
      }

      // 2. Use Save As Picker if available
      if ('showSaveFilePicker' in window) {
          try {
              // @ts-ignore
              const handle = await window.showSaveFilePicker({ suggestedName: defaultName, types: [{ description: desc, accept: { [type]: [ext] } }] });
              // Store handle for future saves if this is a project file
              if (type === 'application/json') setProjectHandle(handle);

              const writable = await handle.createWritable();
              await writable.write(content);
              await writable.close();
              return;
          } catch (err: any) { if (err.name !== 'AbortError') console.error(err); else return; }
      }

      // 3. Fallback to Modal for Firefox/Safari
      setSaveFileNameInput(defaultName);
      setSaveModalConfig({ content, defaultName, type });
      setSaveModalOpen(true);
  }, [projectHandle]);

  const handleSaveModalConfirm = () => {
      if (saveModalConfig) {
          let name = saveFileNameInput.trim() || saveModalConfig.defaultName;
          downloadFile(saveModalConfig.content, name, saveModalConfig.type);
      }
      setSaveModalOpen(false);
      setSaveModalConfig(null);
  };

  const handleSaveProject = useCallback(async () => {
    if(!audioBuffer) { alert("No project data."); return; }
    try {
        const viewState = { zoom, viewStartTime, currentTime, selectionRange };
        const settings = { isLooping, playbackSpeed, showSpectrogram, showPitch, showNotes, mixerState };
        const json = generateProjectJSON(fileName || "project", audioBuffer.sampleRate, analysis.pitchData, analysis.notes, viewState, settings, textAudio ? { fileName: textAudio.name, offset: textAudioOffset, active: audioSource === 'text' } : (textAudioOffset ? { fileName: '', offset: textAudioOffset, active: false } : null));
        const name = (fileName || "project").replace(/\.[^/.]+$/, "");
        await saveFileAs(json, `${name}.tonyweb`, 'application/json', '.tonyweb', 'Tony Web Project');
    } catch(e) { console.error(e); alert("Failed to save."); }
  }, [audioBuffer, fileName, analysis, saveFileAs, zoom, viewStartTime, currentTime, selectionRange, isLooping, playbackSpeed, showSpectrogram, showPitch, showNotes, mixerState, textAudio, textAudioOffset, audioSource]);

  const handleSaveAsProject = useCallback(async () => {
    if(!audioBuffer) { alert("No project data."); return; }
    try {
        const viewState = { zoom, viewStartTime, currentTime, selectionRange };
        const settings = { isLooping, playbackSpeed, showSpectrogram, showPitch, showNotes, mixerState };
        const json = generateProjectJSON(fileName || "project", audioBuffer.sampleRate, analysis.pitchData, analysis.notes, viewState, settings, textAudio ? { fileName: textAudio.name, offset: textAudioOffset, active: audioSource === 'text' } : (textAudioOffset ? { fileName: '', offset: textAudioOffset, active: false } : null));
        const name = (fileName || "project").replace(/\.[^/.]+$/, "");
        await saveFileAs(json, `${name}.tonyweb`, 'application/json', '.tonyweb', 'Tony Web Project', true);
    } catch(e) { console.error(e); alert("Failed to save."); }
  }, [audioBuffer, fileName, analysis, saveFileAs, zoom, viewStartTime, currentTime, selectionRange, isLooping, playbackSpeed, showSpectrogram, showPitch, showNotes, mixerState, textAudio, textAudioOffset, audioSource]);

  // --- Automatic safety copy (IndexedDB) ---
  // On start: offer to restore the last session if there is one.
  useEffect(() => {
    loadAutosave().then(entry => {
      if (!entry) return;
      const data = parseProjectJSON(entry.json);
      if (data && ((data.notes && data.notes.length > 0) || data.pitchData.length > 0)) setRestoreOffer({ data, savedAt: entry.savedAt });
    }).catch(e => console.warn('Autosave not available', e));
  }, []);

  // While working: save 2 s after the last change (never an empty project, so that a good
  // safety copy is not overwritten by a fresh start).
  useEffect(() => {
    if (!audioBuffer) return;
    if (analysis.pitchData.length === 0 && analysis.notes.length === 0) return;
    const handle = window.setTimeout(() => {
      try {
        const viewState = { zoom, viewStartTime, currentTime, selectionRange };
        const settings = { isLooping, playbackSpeed, showSpectrogram, showPitch, showNotes, mixerState };
        const json = generateProjectJSON(fileName || "project", audioBuffer.sampleRate, analysis.pitchData, analysis.notes, viewState, settings, textAudio ? { fileName: textAudio.name, offset: textAudioOffset, active: audioSource === 'text' } : (textAudioOffset ? { fileName: '', offset: textAudioOffset, active: false } : null));
        saveAutosave(json).catch(e => console.warn('Autosave failed', e));
      } catch (e) { console.warn('Autosave failed', e); }
    }, 2000);
    return () => window.clearTimeout(handle);
    // currentTime is deliberately not a dependency (changes every frame during playback)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, audioBuffer, fileName, zoom, viewStartTime, selectionRange, isLooping, playbackSpeed, showSpectrogram, showPitch, showNotes, mixerState, textAudio, textAudioOffset, audioSource]);

  const handleExportPitchCSV = useCallback(async () => {
    const csv = generatePitchCSV(analysis.pitchData);
    const name = (fileName || "track").replace(/\.[^/.]+$/, "");
    await saveFileAs(csv, `${name}_pitch.csv`, 'text/csv', '.csv', 'Pitch CSV');
  }, [analysis.pitchData, fileName, saveFileAs]);

  const handleExportNotesCSV = useCallback(async () => {
    const csv = generateNotesCSV(analysis.notes);
    const name = (fileName || "track").replace(/\.[^/.]+$/, "");
    await saveFileAs(csv, `${name}_notes.csv`, 'text/csv', '.csv', 'Notes CSV');
  }, [analysis.notes, fileName, saveFileAs]);

  const handleExportNotesTSV = useCallback(async () => {
    const tsv = generateNotesTSV(analysis.notes);
    const name = (fileName || "track").replace(/\.[^/.]+$/, "");
    await saveFileAs(tsv, `${name}_Notes.txt`, 'text/plain', '.txt', 'Tony Notes (text)');
  }, [analysis.notes, fileName, saveFileAs]);

  const handleExportSVL = useCallback(async () => {
    if(!audioBuffer) return;
    const xml = generateSVL(analysis.pitchData, analysis.notes, audioBuffer.sampleRate, fileName || "layer");
    const name = (fileName || "track").replace(/\.[^/.]+$/, "");
    await saveFileAs(xml, `${name}.svl`, 'text/xml', '.svl', 'Sonic Visualiser Layer');
  }, [audioBuffer, analysis, fileName, saveFileAs]);

  // --- Load / Import ---
  const applyProjectData = useCallback((data: any, buffer: AudioBuffer) => {
    const sr = buffer.sampleRate;
    setSnapHop(estimateHopSamples(data.pitchData, sr));
    const snappedPitch = data.pitchData.map((f: PitchFrame) => ({...f, timestamp: snapTime(f.timestamp, sr)}));
    const snappedNotes = data.notes.map((n: Note) => ({...n, start: snapTime(n.start, sr), end: snapTime(n.end, sr)}));
    resetHistory({ pitchData: snappedPitch, notes: snappedNotes });
    
    // Restore View State
    if (data.viewState) {
        if (data.viewState.zoom) setZoom(data.viewState.zoom);
        if (data.viewState.viewStartTime !== undefined) setViewStartTime(data.viewState.viewStartTime);
        if (data.viewState.currentTime !== undefined) setCurrentTime(data.viewState.currentTime);
        if (data.viewState.selectionRange) setSelectionRange(data.viewState.selectionRange);
    }

    if (data.textAudio && typeof data.textAudio.offset === 'number') setTextAudioOffset(data.textAudio.offset);

    // Restore Settings
    if (data.settings) {
        if (data.settings.isLooping !== undefined) setIsLooping(data.settings.isLooping);
        if (data.settings.playbackSpeed !== undefined) setPlaybackSpeed(data.settings.playbackSpeed);
        if (data.settings.showSpectrogram !== undefined) setShowSpectrogram(data.settings.showSpectrogram);
        if (data.settings.showPitch !== undefined) setShowPitch(data.settings.showPitch);
        if (data.settings.showNotes !== undefined) setShowNotes(data.settings.showNotes);
        if (data.settings.mixerState) setMixerState(data.settings.mixerState);
    }

  }, [resetHistory]);

  const handleLoadProject = async (file: File) => {
    const data = parseProjectJSON(await file.text());
    if (!data) { alert("Invalid project file"); return; }
    if (audioBuffer && fileName === data.fileName) applyProjectData(data, audioBuffer);
    else { setPendingProjectData(data); setLocateModalOpen(true); }
  };

  const handleImportPitch = useCallback(async (file: File) => {
    let frames = parseCSV(await file.text(), 'pitch');
    if (frames.length > 0 && audioBuffer) {
        const sr = audioBuffer.sampleRate;
        setSnapHop(estimateHopSamples(frames, sr)); // the imported track may have its own time step
        frames = frames.map((f: any) => ({...f, timestamp: snapTime(f.timestamp, sr)}));
    }
    if (frames.length > 0) commitHistory({ ...analysis, pitchData: frames });
  }, [audioBuffer, analysis, commitHistory]);

  const handleImportNotes = useCallback(async (file: File) => {
    let notes = parseCSV(await file.text(), 'note');
    if (notes.length > 0 && audioBuffer) {
        const sr = audioBuffer.sampleRate;
        notes = notes.map((n: any) => ({...n, start: snapTime(n.start, sr), end: snapTime(n.end, sr)}));
    }
    if (notes.length > 0) commitHistory({ ...analysis, notes });
  }, [audioBuffer, analysis, commitHistory]);

  // --- Note & Pitch Operations ---
  const handlePitchCorrection = useCallback((direction: 'up' | 'down') => {
    if (!selectionRange) return;
    const [start, end] = selectionRange;
    let hasChanged = false;
    const newData = analysis.pitchData.map(frame => {
        if (frame.timestamp >= start && frame.timestamp <= end && frame.candidates?.length) {
            const sorted = [...frame.candidates].sort((a, b) => a.frequency - b.frequency);
            const currIdx = sorted.findIndex(c => Math.abs(c.frequency - frame.frequency) < 0.1);
            let newIdx = currIdx;
            
            if (direction === 'up') {
                if (frame.frequency === 0) {
                    const first = sorted.findIndex(c => c.frequency > 0);
                    if (first !== -1) newIdx = first;
                } else if (currIdx < sorted.length - 1) newIdx++;
            } else if (currIdx > 0) newIdx--;

            if (newIdx !== -1 && newIdx !== currIdx) {
                hasChanged = true;
                const sel = sorted[newIdx];
                return { ...frame, frequency: sel.frequency, probability: sel.probability, hasPitch: sel.frequency > 0 };
            }
        }
        return frame;
    });
    if (hasChanged) commitHistory({ ...analysis, pitchData: newData });
  }, [selectionRange, analysis, commitHistory]);

  const handleDeletePitch = useCallback(() => {
    if (!selectionRange) return;
    const [start, end] = selectionRange;
    let hasChanged = false;
    const newData = analysis.pitchData.map(f => {
        if (f.timestamp >= start && f.timestamp <= end && (f.hasPitch || f.frequency > 0)) {
            hasChanged = true;
            return { ...f, frequency: 0, hasPitch: false };
        }
        return f;
    });
    if (hasChanged) commitHistory({ ...analysis, pitchData: newData });
  }, [selectionRange, analysis, commitHistory]);

  const handleCreateNote = useCallback(() => {
    if (!selectionRange) return;
    const [start, end] = selectionRange;
    const filteredNotes = analysis.notes.filter(n => !((n.start + n.end)/2 >= start && (n.start + n.end)/2 <= end));
    const frames = analysis.pitchData.filter(f => f.timestamp >= start && f.timestamp <= end);
    const pitch = calculateMedianPitch(frames);
    
    if (pitch > 0) {
        const replaced = analysis.notes.find(n => ((n.start + n.end)/2 >= start && (n.start + n.end)/2 <= end) && n.text);
        const newNote: Note = { id: crypto.randomUUID(), start, end, pitch, state: 'default', ...(replaced?.text ? { text: replaced.text } : {}) };
        commitHistory({ ...analysis, notes: [...filteredNotes, newNote] });
    } else if (filteredNotes.length !== analysis.notes.length) {
        commitHistory({ ...analysis, notes: filteredNotes });
    }
  }, [selectionRange, analysis, commitHistory]);

  const handleDeleteNotes = useCallback(() => {
    if (!selectionRange) return;
    const [start, end] = selectionRange;
    const newNotes = analysis.notes.filter(n => !((n.start + n.end)/2 >= start && (n.start + n.end)/2 <= end));
    if (newNotes.length !== analysis.notes.length) commitHistory({ ...analysis, notes: newNotes });
  }, [selectionRange, analysis, commitHistory]);

  const handleAutoSegment = useCallback(async () => {
    if (isSegmenting) return;
    if (analysis.pitchData.length < 2) { alert("There is no pitch track yet. Use Extract Pitch or import a pitch track first."); return; }
    const range = selectionRange;

    // Whole file: this replaces all existing notes, so ask first.
    if (!range && analysis.notes.length > 0) {
      const ok = window.confirm(`Replace all ${analysis.notes.length} existing notes with automatically detected notes?\n\n(You can undo this with Ctrl/Cmd+Z.)`);
      if (!ok) return;
    }

    setIsSegmenting(true);
    setSegmentProgress(0);
    try {
      const frames = range
        ? analysis.pitchData.filter(f => f.timestamp >= range[0] && f.timestamp <= range[1])
        : analysis.pitchData;
      let detected: Note[];
      if (segParams.method === 'stable') {
        const times = frames.map(f => f.timestamp);
        const freqs = frames.map(f => (f.hasPitch && f.frequency > 0 ? f.frequency : 0));
        detected = segmentStableRegions(times, freqs, { pitchThreshold: segParams.pitchThreshold, minDur: segParams.pruneSec })
          .map(n => ({ id: crypto.randomUUID(), start: n.start, end: n.end, pitch: n.pitch, state: 'default' as const }));
      } else {
        detected = await segmentNotes(frames, segParams, setSegmentProgress);
      }
      // keep already entered texts where the new notes overlap the old ones
      detected = inheritNoteTexts(range ? analysis.notes.filter(n => (n.start + n.end) / 2 >= range[0] && (n.start + n.end) / 2 <= range[1]) : analysis.notes, detected);

      // With a selection, keep notes outside it (same rule as Create/Delete Note: note midpoint)
      const kept = range
        ? analysis.notes.filter(n => !((n.start + n.end) / 2 >= range[0] && (n.start + n.end) / 2 <= range[1]))
        : [];
      commitHistory({ ...analysis, notes: [...kept, ...detected].sort((a, b) => a.start - b.start) });
      setSelectedNoteId(null);
    } catch (e) {
      console.error(e);
      alert("Automatic segmentation failed.");
    } finally {
      setIsSegmenting(false);
    }
  }, [analysis, selectionRange, segParams, isSegmenting, commitHistory]);

  const handleSplitNote = useCallback(() => {
    let splitTime = audioBuffer ? snapTime(currentTime, audioBuffer.sampleRate) : currentTime;
    const target = analysis.notes.find(n => splitTime > n.start + 0.01 && splitTime < n.end - 0.01);
    if (!target) return;

    const split = splitNote(target, splitTime, analysis.pitchData);
    if (split) {
        const others = analysis.notes.filter(n => n.id !== target.id);
        commitHistory({ ...analysis, notes: [...others, ...split].sort((a, b) => a.start - b.start) });
    }
  }, [currentTime, analysis, audioBuffer, commitHistory]);

  const handleCloseGaps = useCallback(() => {
    if (!selectionRange || segParams.closeGapSec <= 0) return;
    const before = [...analysis.notes].sort((x, y) => x.start - y.start);
    const closed = closeNoteGaps(before, selectionRange, segParams.closeGapSec);
    if (closed.some((n, i) => n.start !== before[i].start || n.end !== before[i].end)) commitHistory({ ...analysis, notes: closed });
  }, [analysis, selectionRange, segParams.closeGapSec, commitHistory]);

  const handleMergeNotes = useCallback(() => {
    const sorted = [...analysis.notes].sort((a, b) => a.start - b.start);
    let group: Note[] = [];
    if (selectionRange) {
      const [s0, s1] = selectionRange;
      group = sorted.filter(n => (n.start + n.end) / 2 >= s0 && (n.start + n.end) / 2 <= s1);
    }
    if (group.length < 2) {
      // selected note, else the note under the cursor, together with the following note
      let idx = selectedNoteId ? sorted.findIndex(n => n.id === selectedNoteId) : -1;
      if (idx < 0) idx = sorted.findIndex(n => currentTime >= n.start && currentTime <= n.end);
      if (idx < 0 || idx >= sorted.length - 1) return;
      group = [sorted[idx], sorted[idx + 1]];
    }
    if (group.length < 2) return;
    const merged = mergeNotes(group, analysis.pitchData);
    const ids = new Set(group.map(n => n.id));
    commitHistory({ ...analysis, notes: [...analysis.notes.filter(n => !ids.has(n.id)), merged].sort((a, b) => a.start - b.start) });
    setSelectedNoteId(merged.id);
  }, [analysis, selectionRange, selectedNoteId, currentTime, commitHistory]);

  const handleNoteResize = useCallback((id: string, start: number, end: number) => {
    const newNotes = resizeNoteWithPush(analysis.notes, id, start, end, analysis.pitchData);
    commitHistory({ ...analysis, notes: newNotes });
  }, [analysis, commitHistory]);

  // --- Note & Pitch Operations (Double Click Workflow) ---
  const handleNoteSelect = useCallback((noteId: string) => {
     const note = analysis.notes.find(n => n.id === noteId);
     if (note && audioBuffer) {
        // Select exactly the note (no surrounding context)
        const range: [number, number] = [note.start, note.end];
        setSelectionRange(range);
        setIsLooping(true);
        // 2. Lock Note
        setSelectedNoteId(noteId);
        // 3. Move playhead to start of selection
        setCurrentTime(range[0]);
     }
  }, [analysis.notes, audioBuffer]);

  const handleNotePitchChange = useCallback((id: string, newPitch: number) => {
      const updatedNotes = analysis.notes.map(n => n.id === id ? { ...n, pitch: newPitch } : n);
      commitHistory({ ...analysis, notes: updatedNotes });
  }, [analysis, commitHistory]);

  const handlePitchDragEnd = useCallback((id: string, newPitch: number) => {
      // 1. Synchronously update the note list for playback
      // Use the optimistically updated pitch since React state (from commitHistory)
      // might not have propagated yet.
      const optimisticNotes = stateRef.current.notes.map(n => n.id === id ? { ...n, pitch: newPitch } : n);
      
      const optimisticState = { ...stateRef.current, notes: optimisticNotes };

      // 2. Restart Playback Synchronously
      if (optimisticState.audioBuffer) {
          audioService.stop();
          playInternal(optimisticState);
      }

      // 3. Commit to History (Async React update)
      // This ensures the visual state becomes permanent
      handleNotePitchChange(id, newPitch);

  }, [handleNotePitchChange]);

  const handlePitchInputCommit = () => {
    if (selectedNoteId && pitchInputValue) {
        const val = parseFloat(pitchInputValue);
        if (!isNaN(val) && val > 0) {
            handlePitchDragEnd(selectedNoteId, val); // Use drag end logic to trigger play
        }
    }
  };

  // --- Text entry mode ---
  // T toggles the mode. In the mode a click on a note selects it, plays it once and shows a
  // text field floating above the note; Return stores the text (mode stays active).
  const TEXT_PAD = 0.12; // seconds of context before/after the note when previewing it
  const sortedNotes = [...analysis.notes].sort((a, b) => a.start - b.start);
  const selectedIndex = selectedNoteId ? sortedNotes.findIndex(n => n.id === selectedNoteId) : -1;
  const suggestions = textEntryActive && selectedIndex >= 0 ? suggestNoteTexts(sortedNotes, selectedIndex, 4) : [];

  // latest values for event handlers that must not use stale closures
  const draftRef = useRef('');
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedNoteId;
  const setDraft = (t: string) => { draftRef.current = t; setTextDraft(t); };

  // Store the draft text of the selected note.
  const commitDraft = () => {
    const id = selectedIdRef.current;
    if (!id) return;
    const st = stateRef.current;
    const cur = st.notes.find(n => n.id === id);
    if (!cur) return;
    const t = draftRef.current.trim();
    if ((cur.text || '') === t) return;
    commitHistory({ pitchData: st.pitchData, notes: st.notes.map(n => n.id === id ? { ...n, text: t || undefined } : n) });
  };

  // Select a note for text entry and play it once (with a little context)
  const focusNoteForText = useCallback((note: Note) => {
    const st = stateRef.current;
    if (!st.audioBuffer) return;
    commitDraft(); // text typed for the previously selected note
    const from = Math.max(0, note.start - TEXT_PAD);
    const to = Math.min(st.duration, note.end + TEXT_PAD);
    setSelectionRange(null);
    setIsLooping(false);
    setSelectedNoteId(note.id);
    selectedIdRef.current = note.id;
    setDraft(note.text || '');
    audioService.stop();
    try {
      audioService.play(st.audioBuffer, st.pitchData, st.notes, from, to - from, st.playbackSpeed);
      playUntilRef.current = to;
      setCurrentTime(from);
      setIsPlaying(true);
    } catch (e) { console.error(e); setIsPlaying(false); }
    window.setTimeout(() => { textInputRef.current?.focus(); textInputRef.current?.select(); }, 0);
  }, []);

  const handleTextNoteClick = useCallback((noteId: string) => {
    const note = stateRef.current.notes.find(n => n.id === noteId);
    if (note) focusNoteForText(note);
  }, [focusNoteForText]);

  // Return: store the text, leave the field (so that T works again); the mode stays active
  const confirmDraft = (override?: string) => {
    if (override !== undefined) setDraft(override);
    commitDraft();
    textInputRef.current?.blur();
  };

  const goToNeighbourNote = (delta: number) => {
    commitDraft();
    const target = sortedNotes[selectedIndex + delta];
    if (target) focusNoteForText(target);
  };

  const toggleTextMode = useCallback(() => {
    if (!stateRef.current.audioBuffer) return;
    if (textEntryActive) {
      commitDraft();
      setTextEntryActive(false);
      audioService.stop();
      playUntilRef.current = null;
      setIsPlaying(false);
    } else {
      if (stateRef.current.notes.length === 0) { alert("There are no notes yet. Use Auto-Segment first."); return; }
      setTextEntryActive(true);
    }
  }, [textEntryActive]);

  // focus the text field whenever another note is selected in text mode
  useEffect(() => {
    if (textEntryActive && selectedNoteId) {
      const id = window.setTimeout(() => { textInputRef.current?.focus(); textInputRef.current?.select(); }, 0);
      return () => window.clearTimeout(id);
    }
  }, [textEntryActive, selectedNoteId]);

  // keep the draft in sync when the selected note changes by other means
  useEffect(() => {
    const n = stateRef.current.notes.find(x => x.id === selectedNoteId);
    setDraft(n?.text || '');
  }, [selectedNoteId]);

  // "T" toggles the text entry mode (when not typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.key === 't' || e.key === 'T') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        toggleTextMode();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleTextMode]);

  const handleTextKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return; // IME composition in progress
    if (e.altKey && /^Digit[1-4]$/.test(e.code)) {
      e.preventDefault();
      const sug = suggestions[parseInt(e.code.slice(5), 10) - 1];
      if (sug !== undefined) confirmDraft(sug);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      const n = sortedNotes[selectedIndex];
      if (n) focusNoteForText(n);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmDraft();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      goToNeighbourNote(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      const n = sortedNotes[selectedIndex];
      setDraft(n?.text || '');
      textInputRef.current?.blur();
    }
  };

  // Position of the floating text field above the selected note
  const floatingField = (() => {
    if (!textEntryActive || !selectedNote) return null;
    const noteY = freqToY(selectedNote.pitch, window.innerHeight - 64 - 64 - 56);
    const cx = ((selectedNote.start + selectedNote.end) / 2 - viewStartTime) * zoom;
    const left = Math.max(70, Math.min(viewportWidth - 70, cx));
    const above = noteY > 90;
    return { left, top: above ? noteY - 20 : noteY + 20, above };
  })();

  // --- Drag & drop of files onto the window ---
  const [isDragOver, setIsDragOver] = useState(false);
  const dropHandlerRef = useRef<(files: File[]) => void>(() => {});
  dropHandlerRef.current = async (files: File[]) => {
    for (const file of files) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (file.type.startsWith('audio/') || ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'aif', 'aiff', 'aac'].includes(ext)) {
        if (!stateRef.current.audioBuffer) { await handleFileSelect(file); continue; }
        const asMain = window.confirm(`"${file.name}"\n\nOK = open as NEW main recording (replaces the current project)\nCancel = use as headset recording (for note texts)`);
        if (asMain) await handleFileSelect(file); else await handleLoadTextAudio(file);
      } else if (ext === 'tonyweb' || ext === 'json') {
        await handleLoadProject(file);
      } else if (ext === 'txt' || ext === 'tsv' || ext === 'csv') {
        if (!stateRef.current.audioBuffer) { alert("Please load an audio file first."); continue; }
        const head = (await file.slice(0, 400).text()).split(/\r?\n/)[0] || '';
        const isPitch = ext === 'csv' && /time|freq|prob/i.test(head) && !/onset|dur/i.test(head);
        if (isPitch) await handleImportPitch(file); else await handleImportNotes(file);
      } else {
        alert(`Unsupported file type: ${file.name}`);
      }
    }
  };
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const onEnter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setIsDragOver(true); } };
    const onLeave = (e: DragEvent) => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (depth === 0) setIsDragOver(false); } };
    const onOver = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0; setIsDragOver(false);
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) dropHandlerRef.current(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  // --- Zoom ---
  const setCenteredZoom = useCallback((newZoom: number) => {
     const viewDur = window.innerWidth / zoom;
     const center = viewStartTime + viewDur / 2;
     const newDur = window.innerWidth / newZoom;
     setZoom(newZoom);
     setViewStartTime(Math.max(0, center - newDur / 2));
  }, [zoom, viewStartTime]);

  const handleZoomWheel = useCallback((dY: number, mTime: number) => {
    const factor = dY > 0 ? 0.8 : 1.25;
    const newZoom = Math.max(10, Math.min(1000, zoom * factor));
    const ratio = zoom / newZoom;
    setViewStartTime(Math.max(0, mTime - (mTime - viewStartTime) * ratio));
    setZoom(newZoom);
  }, [zoom, viewStartTime]);

  // Mouse wheel over the overview: resize the viewport rectangle (up to the whole file)
  const handleMinimapZoom = useCallback((dY: number) => {
    if (duration <= 0) return;
    const minZoom = Math.min(1000, viewportWidth / duration);
    const newZoom = Math.max(minZoom, Math.min(1000, zoom * (dY > 0 ? 0.8 : 1.25)));
    if (newZoom === zoom) return;
    const center = viewStartTime + viewportWidth / zoom / 2;
    const newViewDur = viewportWidth / newZoom;
    setViewStartTime(Math.max(0, Math.min(center - newViewDur / 2, duration - newViewDur)));
    setZoom(newZoom);
  }, [zoom, viewStartTime, viewportWidth, duration]);

  // --- Initialize Keyboard Shortcuts ---
  useKeyboardShortcuts({
    onPlayPause: handlePlayPause,
    onDeleteNotes: handleDeleteNotes,
    onCreateNote: handleCreateNote,
    onSplitNote: handleSplitNote,
    onMergeNotes: handleMergeNotes,
    onToggleCandidates: () => setShowCandidates(p => !p),
    onSaveProject: handleSaveProject,
    onUndo: undo,
    onRedo: redo,
    onPitchCorrection: handlePitchCorrection,
    onSeek: handleSeek,
    currentTime: currentTime
  });

  return (
    <div className="flex flex-col h-screen w-screen bg-white text-gray-900 font-sans overflow-hidden">
      {isDragOver && (
        <div className="fixed inset-0 z-[200] bg-blue-500/20 border-4 border-dashed border-blue-500 flex items-center justify-center pointer-events-none">
          <div className="bg-white/90 rounded-lg px-6 py-4 text-lg font-semibold text-blue-700 shadow">
            Drop file: audio · project (.tonyweb) · notes / pitch (.txt .csv)
          </div>
        </div>
      )}
      <Controls 
        isPlaying={isPlaying} isLooping={isLooping}
        onPlayPause={handlePlayPause} onStop={handleStop} onRewind={handleRewind}
        onToggleLoop={() => setIsLooping(!isLooping)}
        onZoomIn={() => setCenteredZoom(Math.min(zoom * 1.5, 1000))}
        onZoomOut={() => setCenteredZoom(Math.max(zoom / 1.5, 10))}
        onFileLoad={handleFileSelect} onExtractPitch={handleExtractPitch}
        onSaveProject={handleSaveProject} onSaveAsProject={handleSaveAsProject} onLoadProject={handleLoadProject}
        onExportPitchCSV={handleExportPitchCSV} onExportNotesCSV={handleExportNotesCSV} onExportSVL={handleExportSVL}
        onImportPitch={handleImportPitch} onImportNotes={handleImportNotes}
        isAnalyzing={analysisStatus.isAnalyzing} isRecalculating={isRecalculating}
        hasData={!!audioBuffer} fileName={fileName}
        selectionActive={selectionRange !== null} showCandidates={showCandidates}
        onToggleCandidates={() => setShowCandidates(!showCandidates)}
        onShiftUp={() => handlePitchCorrection('up')} onShiftDown={() => handlePitchCorrection('down')}
        onRecalculateCandidates={handleRecalculateCandidates} onDeletePitch={handleDeletePitch}
        onSnapPitch={handleSnapPitch} snapMaxRatio={snapMaxRatio} onSnapMaxRatioChange={setSnapMaxRatio}
        onCreateNote={handleCreateNote} onDeleteNote={handleDeleteNotes} onSplitNote={handleSplitNote} onMergeNotes={handleMergeNotes} onCloseGaps={handleCloseGaps}
        onAutoSegment={handleAutoSegment} isSegmenting={isSegmenting}
        onStartTextEntry={toggleTextMode} textEntryActive={textEntryActive}
        onLoadTextAudio={handleLoadTextAudio} textAudioName={textAudio?.name ?? null}
        onExportNotesTSV={handleExportNotesTSV}
        segParams={segParams} onSegParamsChange={setSegParams}
        pitchHop={pitchHop} onPitchHopChange={setPitchHop} pitchWindow={pitchWindow} onPitchWindowChange={setPitchWindow}
        pitchMethod={pitchMethod} onPitchMethodChange={setPitchMethod} eckfC={eckfC} onEckfCChange={setEckfC}
        canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo}
      />

      {/* Save Modal */}
      {saveModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
              <div className="bg-white p-6 rounded-lg shadow-2xl w-96 border">
                  <h3 className="text-lg font-semibold mb-4">Save File</h3>
                  <input autoFocus type="text" className="w-full border rounded px-3 py-2 mb-6"
                      value={saveFileNameInput} onChange={(e) => setSaveFileNameInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSaveModalConfirm()}
                  />
                  <div className="flex justify-end gap-3">
                      <button onClick={() => setSaveModalOpen(false)} className="px-4 py-2 hover:bg-gray-100 rounded">Cancel</button>
                      <button onClick={handleSaveModalConfirm} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">Download</button>
                  </div>
              </div>
          </div>
      )}

      {/* Restore last session */}
      {restoreOffer && !audioBuffer && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
              <div className="bg-white p-6 rounded-lg shadow-2xl w-[450px] border">
                  <h3 className="text-lg font-semibold mb-2">Restore last session?</h3>
                  <div className="bg-blue-50 border-l-4 border-blue-400 p-4 mb-4 text-sm text-blue-800">
                      Automatic safety copy of <strong>{restoreOffer.data.fileName || 'project'}</strong><br/>
                      {restoreOffer.data.notes?.length ?? 0} notes, saved {new Date(restoreOffer.savedAt).toLocaleString()}.<br/>
                      After clicking Restore you will be asked to locate the audio file again.
                  </div>
                  <div className="flex justify-end gap-3">
                      <button onClick={() => { clearAutosave().catch(() => {}); setRestoreOffer(null); }} className="px-4 py-2 hover:bg-gray-100 rounded">Discard</button>
                      <button onClick={() => { setPendingProjectData(restoreOffer.data); setLocateModalOpen(true); setRestoreOffer(null); }} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">Restore</button>
                  </div>
              </div>
          </div>
      )}

      {/* Locate Modal */}
      {locateModalOpen && pendingProjectData && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
              <div className="bg-white p-6 rounded-lg shadow-2xl w-[450px] border">
                  <h3 className="text-lg font-semibold mb-2">Locate Audio File</h3>
                  <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-4 text-sm text-yellow-700">
                      Project references <strong>{pendingProjectData.fileName}</strong>.<br/>Please manually locate this file.
                  </div>
                  <div className="flex justify-end gap-3">
                      <button onClick={() => { setLocateModalOpen(false); setPendingProjectData(null); }} className="px-4 py-2 hover:bg-gray-100 rounded">Cancel</button>
                      <button onClick={() => fileLocateInputRef.current?.click()} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">Locate File...</button>
                  </div>
                  <input ref={fileLocateInputRef} type="file" accept="audio/*" onChange={(e) => { if(e.target.files?.[0]) handleLocateAudio(e.target.files[0]); }} className="hidden" />
              </div>
          </div>
      )}

      {/* Main View */}
      <div className="flex-1 relative flex flex-col min-h-0 bg-white">
        {analysisStatus.isAnalyzing && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-white/80 backdrop-blur-sm">
                <div className="bg-white p-6 rounded-lg shadow-xl border text-center">
                    <h3 className="text-xl font-semibold mb-2">Extracting Pitch...</h3>
                    <div className="w-64 h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-600 transition-all" style={{ width: `${analysisStatus.progress * 100}%` }} />
                    </div>
                </div>
            </div>
        )}

        {isSegmenting && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-white/80 backdrop-blur-sm">
                <div className="bg-white p-6 rounded-lg shadow-xl border text-center">
                    <h3 className="text-xl font-semibold mb-2">Segmenting Notes...</h3>
                    <div className="w-64 h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-600 transition-all" style={{ width: `${segmentProgress * 100}%` }} />
                    </div>
                </div>
            </div>
        )}

        {/* Note Inspector (Floating) */}
        {selectedNoteId && selectedNote && (
            <div className="absolute top-2 right-4 z-20 bg-white shadow-md border rounded-md p-2 flex items-center gap-2 text-sm">
                {!textEntryActive && (<>
                <span className="font-semibold text-gray-500 text-xs uppercase">Text</span>
                <input
                    ref={textInputRef}
                    type="text"
                    className="w-28 border rounded px-1 py-0.5 text-base"
                    placeholder="…"
                    value={textDraft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitDraft()}
                    onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); commitDraft(); e.currentTarget.blur(); } }}
                    title="Note text (Enter to store). Press T for the fast text entry mode."
                />
                <div className="w-px h-4 bg-gray-300 mx-1"></div>
                </>)}
                <span className="font-semibold text-gray-500 text-xs uppercase">Note Pitch</span>
                <input 
                    type="number" 
                    step="0.01"
                    className="w-20 border rounded px-1 py-0.5 text-right font-mono"
                    value={pitchInputValue}
                    onChange={(e) => setPitchInputValue(e.target.value)}
                    onBlur={handlePitchInputCommit}
                    onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur())}
                />
                <span className="text-gray-500">Hz</span>
                <div className="w-px h-4 bg-gray-300 mx-1"></div>
                <button 
                    onClick={() => { commitDraft(); setSelectedNoteId(null); setSelectionRange(null); setIsLooping(false); }}
                    className="p-1 hover:bg-gray-100 text-gray-400 rounded"
                    title="Close"
                >
                    <X size={14} />
                </button>
            </div>
        )}

        {floatingField && selectedNote && (
            <div
                className="absolute z-30 flex flex-col items-center gap-1"
                style={{ left: floatingField.left, top: floatingField.top, transform: floatingField.above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)' }}
                onMouseDown={(e) => e.stopPropagation()}
            >
                {suggestions.length > 0 && (
                    <div className="flex items-center gap-1">
                        {suggestions.map((sg, i) => (
                            <button
                                key={sg}
                                onMouseDown={(e) => { e.preventDefault(); confirmDraft(sg); }}
                                className="px-1.5 py-0.5 text-xs bg-white/95 hover:bg-blue-100 border border-blue-300 rounded shadow-sm"
                                title={`Alt+${i + 1}`}
                            >
                                <span className="text-gray-400 mr-0.5">{i + 1}</span>{sg}
                            </button>
                        ))}
                    </div>
                )}
                <input
                    ref={textInputRef}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-32 text-center text-lg border-2 border-blue-600 rounded shadow-lg px-1 py-0.5 bg-white focus:outline-none"
                    placeholder="…"
                    value={textDraft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitDraft()}
                    onKeyDown={handleTextKeyDown}
                    title="Return: store · Tab / Shift+Tab: next / previous note · Ctrl/Cmd+Return: replay · Alt+1..4: suggestion · Esc: undo typing · T (outside the field): leave text mode"
                />
            </div>
        )}

        <PitchVisualizer 
          pitchData={analysis.pitchData} notes={analysis.notes}
          spectrogramData={spectrogramData} showSpectrogram={showSpectrogram}
          showPitch={showPitch} showNotes={showNotes}
          currentTime={currentTime} duration={duration} zoom={zoom}
          containerHeight={window.innerHeight - 64 - 64 - 56} 
          viewStartTime={viewStartTime} selectionRange={selectionRange}
          textMode={textEntryActive} onTextNoteClick={handleTextNoteClick}
          showCandidates={showCandidates} freqRange={freqRange} frameDuration={audioBuffer ? dataHop / audioBuffer.sampleRate : 0}
          onViewScroll={setViewStartTime} onSeek={handleSeek} onZoomWheel={handleZoomWheel}
          onSelectionChange={handleSelectionChange} onNoteResize={handleNoteResize}
          // New Props
          selectedNoteId={selectedNoteId}
          onNoteSelect={handleNoteSelect}
          onNotePitchChange={handleNotePitchChange}
          onPitchDragEnd={handlePitchDragEnd}
        />
        
        {!fileName && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-gray-400 opacity-50">
                <div className="text-center"><p className="text-3xl font-bold">Tony Web</p><p>Load an audio file to begin</p></div>
            </div>
        )}
      </div>

      <div className="flex-none shadow-sm z-10 relative">
        <WaveformNavigator 
          audioBuffer={audioBuffer} currentTime={currentTime} duration={duration}
          onSeek={handleSeek} viewStartTime={viewStartTime}
          viewDuration={zoom > 0 ? viewportWidth / zoom : 0} onViewChange={setViewStartTime}
          onZoomWheel={handleMinimapZoom}
        />
      </div>

      <Mixer 
        mixerState={mixerState} 
        onUpdate={useCallback((u: Partial<MixerState>) => setMixerState(p => ({ ...p, ...u })), [])}
        showSpectrogram={showSpectrogram}
        onToggleSpectrogram={() => setShowSpectrogram(!showSpectrogram)}
        showPitch={showPitch} onTogglePitch={() => setShowPitch(!showPitch)}
        showNotes={showNotes} onToggleNotes={() => setShowNotes(!showNotes)}
        playbackSpeed={playbackSpeed}
        onPlaybackSpeedChange={handleSpeedChange}
        freqRange={freqRange} onFreqRangeChange={setFreqRange}
        textAudioName={textAudio?.name ?? null}
        audioSource={audioSource} onAudioSourceChange={setAudioSource}
        textAudioOffset={textAudioOffset} onTextAudioOffsetChange={setTextAudioOffset}
      />
    </div>
  );
}

export default App;
