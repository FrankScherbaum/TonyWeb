
import React, { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { PitchFrame, Note, SpectrogramData } from '../types';
import { setFreqViewRange, drawSpectrogram, drawGrid, drawNotes, drawPitchCurve, drawCandidates, drawSelection, freqToY, yToFreq, hzToNoteName } from '../utils/renderUtils';
import { getSnappedTime, findNoteInteraction, InteractionMode } from '../utils/interactionUtils';
import { DIMENSIONS, COLORS } from '../constants';

interface PitchVisualizerProps {
  pitchData: PitchFrame[];
  notes: Note[]; 
  spectrogramData: SpectrogramData | null;
  showSpectrogram: boolean;
  showPitch: boolean;
  showNotes: boolean;
  currentTime: number;
  duration: number;
  zoom: number; // Pixels per second
  containerHeight: number;
  viewStartTime: number;
  selectionRange: [number, number] | null;
  showCandidates: boolean;
  freqRange?: [number, number];
  textMode?: boolean;
  onTextNoteClick?: (noteId: string) => void;
  frameDuration: number; // New prop for grid snapping
  onViewScroll: (startTime: number) => void;
  onSeek: (time: number) => void;
  onZoomWheel: (deltaY: number, mouseTime: number) => void;
  onSelectionChange: (range: [number, number] | null) => void;
  onNoteResize: (noteId: string, newStart: number, newEnd: number) => void;
  
  // Note Pitch Editing
  selectedNoteId: string | null;
  onNoteSelect: (noteId: string) => void;
  onNotePitchChange: (noteId: string, newPitch: number) => void;
  onPitchDragEnd: (noteId: string, newPitch: number) => void;
}

const PitchVisualizer: React.FC<PitchVisualizerProps> = ({
  pitchData,
  notes,
  spectrogramData,
  showSpectrogram,
  showPitch,
  showNotes,
  currentTime,
  duration,
  zoom,
  containerHeight,
  viewStartTime,
  selectionRange,
  showCandidates,
  freqRange = [50, 5000],
  textMode = false,
  onTextNoteClick,
  frameDuration,
  onViewScroll,
  onSeek,
  onZoomWheel,
  onSelectionChange,
  onNoteResize,
  selectedNoteId,
  onNoteSelect,
  onNotePitchChange,
  onPitchDragEnd
}) => {
  // Set the visible frequency range before anything is drawn / hit-tested
  setFreqViewRange(freqRange[0], freqRange[1]);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // Flag to ignore scroll events triggered by our own zoom logic
  const isProgrammaticScroll = useRef(false);
  
  // Derived width
  const width = Math.max(window.innerWidth, duration * zoom + window.innerWidth);

  // Interaction State
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('NONE');
  const dragStartRef = useRef<number>(0); // Raw time for click detection
  
  const selectionAnchorRef = useRef<number>(0); // Snapped time for selection logic
  const initialSelectionRef = useRef<[number, number] | null>(null);

  // Direct Note Resizing State
  const activeNoteIdRef = useRef<string | null>(null);
  const activeNoteInitialBoundsRef = useRef<[number, number] | null>(null);
  
  // Dragged Note State (Visuals) & Ref (Logic)
  const [draggedNoteState, setDraggedNoteState] = useState<{id: string, start: number, end: number, pitch?: number} | null>(null);
  const draggedNoteRef = useRef<{id: string, start: number, end: number, pitch?: number} | null>(null);

  // Vertical Drag State
  const initialDragYRef = useRef<number>(0);
  const initialNotePitchRef = useRef<number>(0);

  // Hover Info State
  const [hoveredNoteInfo, setHoveredNoteInfo] = useState<{ onset: number, pitch: number, text?: string } | null>(null);

  // Handle Scroll
  const handleScroll = () => {
    if (isProgrammaticScroll.current) return;
    if (containerRef.current) {
        const time = containerRef.current.scrollLeft / zoom;
        onViewScroll(time);
    }
  };

  // Sync scroll position from external
  useLayoutEffect(() => {
    if (containerRef.current) {
        const targetScroll = viewStartTime * zoom;
        if (Math.abs(containerRef.current.scrollLeft - targetScroll) > 1) {
            isProgrammaticScroll.current = true;
            containerRef.current.scrollLeft = targetScroll;
            setTimeout(() => { isProgrammaticScroll.current = false; }, 50);
        }
    }
  }, [viewStartTime, zoom]);

  const handleWheel = (e: React.WheelEvent) => {
    if (e.deltaY !== 0) {
      e.preventDefault();
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const scrollLeft = containerRef.current.scrollLeft;
        const mouseX = e.clientX - rect.left;
        const mouseTime = (scrollLeft + mouseX) / zoom;
        onZoomWheel(e.deltaY, mouseTime);
      }
    }
  };

  const getMouseInfo = (clientX: number, clientY: number) => {
    if (!containerRef.current) return { time: 0, y: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    const scrollLeft = containerRef.current.scrollLeft;
    
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    
    const time = Math.max(0, Math.min(duration, (scrollLeft + x) / zoom));
    return { time, y };
  };

  // Handle Double Click to Select Note
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (textMode) return;
    const { time, y } = getMouseInfo(e.clientX, e.clientY);
    const NOTE_HEIGHT = DIMENSIONS.noteInteractionHeight; 

    const note = notes.find(n => {
        const nY = freqToY(n.pitch, containerHeight);
        const inTime = time >= n.start && time <= n.end;
        const inPitch = Math.abs(y - nY) < NOTE_HEIGHT;
        return inTime && inPitch;
    });
    
    if (note) {
        // Trigger context selection logic in App
        onNoteSelect(note.id);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); 
    
    const { time: rawTime, y: mouseY } = getMouseInfo(e.clientX, e.clientY);
    dragStartRef.current = rawTime;

    // Text entry mode: a click on a note selects it for text input
    if (textMode && onTextNoteClick) {
        const hit = notes.find(n => rawTime >= n.start && rawTime <= n.end &&
            Math.abs(mouseY - freqToY(n.pitch, containerHeight)) < DIMENSIONS.noteInteractionHeight);
        if (hit) { onTextNoteClick(hit.id); return; }
    }

    let mode: InteractionMode = 'SELECTING';
    
    // 1. Check Note Interactions
    if (showNotes) {
        const interaction = findNoteInteraction(rawTime, mouseY, notes, zoom, containerHeight, selectedNoteId);
        if (interaction) {
            mode = interaction.mode;
            activeNoteIdRef.current = interaction.noteId;
            activeNoteInitialBoundsRef.current = interaction.bounds;
            
            // Store initial pitch for vertical drag
            initialDragYRef.current = mouseY;
            initialNotePitchRef.current = interaction.pitch || 0;

            const newState = { 
                id: interaction.noteId, 
                start: interaction.bounds[0], 
                end: interaction.bounds[1],
                pitch: interaction.pitch
            };
            setDraggedNoteState(newState);
            draggedNoteRef.current = newState;
        }
    }

    // 2. Check Selection Handles (Secondary Priority)
    if (mode === 'SELECTING' && selectionRange) {
        const handleThreshold = DIMENSIONS.handleThresholdPx / zoom;
        const [start, end] = selectionRange;
        if (Math.abs(rawTime - start) < handleThreshold) {
            mode = 'RESIZE_SELECTION_START';
        } else if (Math.abs(rawTime - end) < handleThreshold) {
            mode = 'RESIZE_SELECTION_END';
        }
    }
    
    // Determine the anchor point for selection operations
    if (mode === 'SELECTING') {
        selectionAnchorRef.current = getSnappedTime(rawTime, notes, zoom, frameDuration, duration, null, e.shiftKey);
    }

    initialSelectionRef.current = selectionRange;
    setInteractionMode(mode);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const { time: rawTime, y: mouseY } = getMouseInfo(e.clientX, e.clientY);
    const snappedTime = getSnappedTime(rawTime, notes, zoom, frameDuration, duration, activeNoteIdRef.current, e.shiftKey); 

    // Update Cursor Style & Hover Info
    if (interactionMode === 'NONE' && containerRef.current) {
        let cursor = 'crosshair';
        let foundHoverNote = null;
        
        if (showNotes) {
            // Re-use logic for finding hover targets, but simplified for display
            const NOTE_HALF_HEIGHT = DIMENSIONS.noteInteractionHeight / 2;
            const hoveredNote = notes.find(note => {
                const noteY = freqToY(note.pitch, containerHeight);
                const inTime = rawTime >= note.start && rawTime <= note.end;
                const inPitch = Math.abs(mouseY - noteY) < NOTE_HALF_HEIGHT;
                return inTime && inPitch;
            });
            
            if (hoveredNote) {
                foundHoverNote = { onset: hoveredNote.start, pitch: hoveredNote.pitch, text: hoveredNote.text };
            }

            // Check boundaries for cursor change
            const interaction = findNoteInteraction(rawTime, mouseY, notes, zoom, containerHeight, selectedNoteId);
            if (interaction) {
                if (interaction.mode === 'MOVE_VERTICAL') cursor = 'ns-resize';
                else cursor = 'ew-resize';
            }
        }
        setHoveredNoteInfo(foundHoverNote);

        // Check Selection Handles
        if (cursor === 'crosshair' && selectionRange) {
            const handleThreshold = DIMENSIONS.handleThresholdPx / zoom;
            const [start, end] = selectionRange;
            if (Math.abs(rawTime - start) < handleThreshold || Math.abs(rawTime - end) < handleThreshold) {
                cursor = 'col-resize';
            }
        }
        containerRef.current.style.cursor = cursor;
    }

    // Handle Active Interactions
    if (interactionMode !== 'NONE') {
        if (interactionMode === 'SELECTING') {
            const anchor = selectionAnchorRef.current;
            const start = Math.min(anchor, snappedTime);
            const end = Math.max(anchor, snappedTime);
            onSelectionChange([start, end]);

        } else if (interactionMode === 'RESIZE_SELECTION_START' && initialSelectionRef.current) {
            const oldEnd = initialSelectionRef.current[1];
            const newStart = Math.min(snappedTime, oldEnd - 0.001);
            onSelectionChange([newStart, oldEnd]);

        } else if (interactionMode === 'RESIZE_SELECTION_END' && initialSelectionRef.current) {
            const oldStart = initialSelectionRef.current[0];
            const newEnd = Math.max(snappedTime, oldStart + 0.001);
            onSelectionChange([oldStart, newEnd]);

        } else if (interactionMode === 'RESIZE_NOTE_START' && activeNoteInitialBoundsRef.current) {
            const oldEnd = activeNoteInitialBoundsRef.current[1];
            const newStart = Math.min(snappedTime, oldEnd - 0.001);
            if (activeNoteIdRef.current && draggedNoteRef.current) {
                const newState = { ...draggedNoteRef.current, start: newStart, end: oldEnd };
                setDraggedNoteState(newState);
                draggedNoteRef.current = newState;
            }

        } else if (interactionMode === 'RESIZE_NOTE_END' && activeNoteInitialBoundsRef.current) {
            const oldStart = activeNoteInitialBoundsRef.current[0];
            const newEnd = Math.max(snappedTime, oldStart + 0.001);
            if (activeNoteIdRef.current && draggedNoteRef.current) {
                const newState = { ...draggedNoteRef.current, start: oldStart, end: newEnd };
                setDraggedNoteState(newState);
                draggedNoteRef.current = newState;
            }
        } else if (interactionMode === 'MOVE_VERTICAL' && draggedNoteRef.current) {
             // Calculate Pitch Change
             const deltaY = mouseY - initialDragYRef.current;
             const initialY = freqToY(initialNotePitchRef.current, containerHeight);
             const newY = initialY + deltaY;
             const newPitch = yToFreq(newY, containerHeight);
             const newState = { ...draggedNoteRef.current, pitch: newPitch };
             
             setDraggedNoteState(newState);
             draggedNoteRef.current = newState;
        }
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    // Commit Smart Note Resize
    if ((interactionMode === 'RESIZE_NOTE_START' || interactionMode === 'RESIZE_NOTE_END') && draggedNoteRef.current) {
        onNoteResize(draggedNoteRef.current.id, draggedNoteRef.current.start, draggedNoteRef.current.end);
    }
    
    // Commit Pitch Change
    if (interactionMode === 'MOVE_VERTICAL' && draggedNoteRef.current && draggedNoteRef.current.pitch) {
        onNotePitchChange(draggedNoteRef.current.id, draggedNoteRef.current.pitch);
        // Trigger Auditory Feedback with explicit arguments
        onPitchDragEnd(draggedNoteRef.current.id, draggedNoteRef.current.pitch);
    }
    
    // Commit Smart Selection Resize
    if ((interactionMode === 'RESIZE_SELECTION_START' || interactionMode === 'RESIZE_SELECTION_END') && initialSelectionRef.current && selectionRange) {
        const [initStart, initEnd] = initialSelectionRef.current;
        const [currStart, currEnd] = selectionRange;
        const matchingNote = notes.find(n => Math.abs(n.start - initStart) < 0.001 && Math.abs(n.end - initEnd) < 0.001);
        if (matchingNote) {
            onNoteResize(matchingNote.id, currStart, currEnd);
        }
    }

    if (interactionMode === 'SELECTING') {
        const { time } = getMouseInfo(e.clientX, e.clientY);
        const diff = Math.abs(time - dragStartRef.current);
        if (diff < (3 / zoom)) { 
             // Click (not drag)
             if (!selectionRange || (time < selectionRange[0] || time > selectionRange[1])) {
                 onSelectionChange(null);
                 onSeek(time);
             } else {
                onSeek(time);
             }
        }
    }
    
    // Clear Drag State
    setInteractionMode('NONE');
    setDraggedNoteState(null);
    draggedNoteRef.current = null;
    activeNoteIdRef.current = null;
    activeNoteInitialBoundsRef.current = null;
  };

  // --- DRAW CANVAS ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // The canvas only covers the visible part of the timeline (a canvas as wide as the whole
    // timeline - duration * zoom - exceeds the browser's canvas size limit at high zoom and
    // then stays blank). All draw functions use absolute x = time * zoom, so the context is
    // shifted by the current scroll position.
    const visibleWidth = window.innerWidth;
    canvas.width = visibleWidth;
    canvas.height = containerHeight;
    const scrollX = containerRef.current ? containerRef.current.scrollLeft : viewStartTime * zoom;
    const viewStart = scrollX / zoom;

    // 1. Clear & Background
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, visibleWidth, containerHeight);
    ctx.translate(-scrollX, 0);

    // 2. Spectrogram
    if (showSpectrogram) {
        drawSpectrogram(ctx, spectrogramData, pitchData, viewStart, zoom, visibleWidth, containerHeight, duration, showPitch);
    }
    
    // 3. Selection (Background highlight)
    if (selectionRange) {
        drawSelection(ctx, selectionRange, viewStart, zoom, visibleWidth, containerHeight);
    }

    // 4. Grid
    drawGrid(ctx, viewStart, zoom, visibleWidth, containerHeight);

    // 5. Notes
    if (showNotes) {
        // If we are dragging a note, we temporarily swap the original note with the dragged state for rendering
        const displayNotes = draggedNoteState 
            ? notes.map(n => n.id === draggedNoteState.id ? { ...n, start: draggedNoteState.start, end: draggedNoteState.end, pitch: draggedNoteState.pitch || n.pitch } : n)
            : notes;

        // Pass selected ID for highlighting
        drawNotes(ctx, displayNotes, viewStart, zoom, visibleWidth, containerHeight, selectedNoteId);
    }

    // 6. Candidates
    if (showCandidates && selectionRange && showPitch) {
        drawCandidates(ctx, pitchData, viewStart, zoom, visibleWidth, containerHeight, selectionRange);
    }

    // 7. Main Pitch
    if (showPitch) {
        drawPitchCurve(ctx, pitchData, viewStart, zoom, visibleWidth, containerHeight);
    }
    
  }, [pitchData, notes, spectrogramData, showSpectrogram, width, zoom, containerHeight, selectionRange, showCandidates, viewStartTime, showPitch, showNotes, duration, draggedNoteState, selectedNoteId, freqRange[0], freqRange[1]]);

  return (
    <div className="flex-1 relative overflow-hidden bg-white">
        <div 
            ref={containerRef} 
            className="w-full h-full overflow-hidden bg-white relative select-none"
            style={{ height: containerHeight }}
            onScroll={handleScroll}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onDoubleClick={handleDoubleClick}
            onMouseLeave={() => { setInteractionMode('NONE'); setDraggedNoteState(null); draggedNoteRef.current = null; setHoveredNoteInfo(null); }}
        >
        <div style={{ width: width, height: containerHeight, position: 'relative' }}>
            <canvas 
                ref={canvasRef}
                className="block"
                style={{ position: 'sticky', left: 0, top: 0, height: containerHeight }}
            />
        </div>
        
        <div 
            className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10 pointer-events-none opacity-80"
            style={{ 
            left: `${currentTime * zoom}px`,
            height: containerHeight 
            }}
        />
        </div>

        {/* Hover Info Overlay - Now positioned relative to the Viewport Wrapper */}
        {hoveredNoteInfo && (
            <div className="absolute top-4 right-4 z-20 bg-black/70 text-white text-xs px-2 py-1 rounded shadow pointer-events-none font-mono">
                {hoveredNoteInfo.text && <span className="mr-3 font-bold">{hoveredNoteInfo.text}</span>}
                <span className="mr-3">Onset: {hoveredNoteInfo.onset.toFixed(3)}s</span>
                <span>{hoveredNoteInfo.pitch.toFixed(1)}Hz ({hzToNoteName(hoveredNoteInfo.pitch)})</span>
            </div>
        )}
    </div>
  );
};

export default React.memo(PitchVisualizer);
