
import { PitchFrame, Note, SpectrogramData } from '../types';
import { COLORS, DIMENSIONS, ANALYSIS } from '../constants';

// Visible frequency range of the (logarithmic) vertical axis
let viewMinHz: number = ANALYSIS.minPitch;
let viewMaxHz: number = ANALYSIS.maxPitch;
export const setFreqViewRange = (minHz: number, maxHz: number) => {
    if (minHz > 0 && maxHz > minHz) { viewMinHz = minHz; viewMaxHz = maxHz; }
};

// Coordinate helpers (y is logarithmic in frequency)
export const freqToY = (f: number, containerHeight: number) => {
    const logF = Math.log(f);
    const logMin = Math.log(viewMinHz);
    const logMax = Math.log(viewMaxHz);
    const normalized = (logF - logMin) / (logMax - logMin);
    const availableHeight = containerHeight - DIMENSIONS.rulerHeight;
    return (containerHeight) - (normalized * availableHeight);
};

export const yToFreq = (y: number, containerHeight: number) => {
     const availableHeight = containerHeight - DIMENSIONS.rulerHeight;
     const normalized = (containerHeight - y) / availableHeight;
     const logMin = Math.log(viewMinHz);
     const logMax = Math.log(viewMaxHz);
     const logF = normalized * (logMax - logMin) + logMin;
     return Math.exp(logF);
};

export const hzToNoteName = (hz: number): string => {
    if (hz <= 0) return '';
    const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const midi = 69 + 12 * Math.log2(hz / 440);
    const rounded = Math.round(midi);
    const note = NOTES[rounded % 12];
    const oct = Math.floor(rounded / 12) - 1;
    return `${note}${oct}`;
};

export const formatTime = (seconds: number, interval: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (interval < 1) {
     const ms = Math.round((seconds % 1) * 10);
     return `${m}:${s.toString().padStart(2, '0')}.${ms}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
};

// --- DRAWING FUNCTIONS ---

export const drawSpectrogram = (
    ctx: CanvasRenderingContext2D,
    spectrogramData: SpectrogramData | null,
    pitchData: PitchFrame[],
    viewStartTime: number,
    zoom: number,
    visibleWidth: number,
    containerHeight: number,
    duration: number,
    showPitchMask: boolean
) => {
    if (!spectrogramData || duration <= 0) return;
    const { magnitude2d, width: specWidth, height: specHeight, maxMagnitude } = spectrogramData;

    const imgWidth = Math.ceil(visibleWidth);
    const imgHeight = containerHeight - DIMENSIONS.rulerHeight;
    if (imgWidth <= 0 || imgHeight <= 0) return;

    const imageData = ctx.createImageData(imgWidth, imgHeight);
    const data = imageData.data;

    // Pre-calculate Pitch Trajectory for Suppression
    const pitchMap = new Float32Array(imgWidth).fill(-1);
    if (showPitchMask) {
        let pIdx = 0;
        while(pIdx < pitchData.length && pitchData[pIdx].timestamp < viewStartTime) pIdx++;
        for (let x = 0; x < imgWidth; x++) {
            const time = viewStartTime + (x / zoom);
            while(pIdx < pitchData.length - 1 && pitchData[pIdx + 1].timestamp <= time) pIdx++;
            const frame = pitchData[pIdx];
            if (frame && Math.abs(frame.timestamp - time) < (0.1) && frame.hasPitch) {
                pitchMap[x] = freqToY(frame.frequency, containerHeight) - DIMENSIONS.rulerHeight;
            }
        }
    }

    // Pre-calc Y to Bin mapping
    const binMap = new Float32Array(imgHeight);
    for(let y = 0; y < imgHeight; y++) {
         const canvasY = y + DIMENSIONS.rulerHeight;
         const freq = yToFreq(canvasY, containerHeight);
         const nyquist = (spectrogramData.sampleRate ?? 44100) / 2;
         const bin = (freq / nyquist) * specHeight;
         binMap[y] = bin;
    }

    for (let x = 0; x < imgWidth; x++) {
         const time = viewStartTime + (x / zoom);
         const frameIdx = Math.floor((time / duration) * specWidth);
         
         if (frameIdx >= 0 && frameIdx < specWidth) {
             const magFrame = magnitude2d[frameIdx];
             if (!magFrame) continue;

             const f0_y = pitchMap[x];

             for (let y = 0; y < imgHeight; y++) {
                 const binPos = binMap[y];
                 const bin = Math.floor(binPos);
                 
                 if (bin >= 0 && bin < specHeight - 1) {
                     const frac = binPos - bin;
                     const m1 = magFrame[bin];
                     const m2 = magFrame[bin+1];
                     const mag = m1 + (m2 - m1) * frac;
                     
                     let db = 20 * Math.log10(mag / maxMagnitude + 1e-6); 
                     let norm = (db + ANALYSIS.spectrogramDbRange) / ANALYSIS.spectrogramDbRange; 
                     norm = Math.max(0, Math.min(1, norm));
                     norm = Math.pow(norm, 3.0);
                     const val = Math.floor((1 - norm) * 255);
                     
                     if (f0_y > 0 && Math.abs(y - f0_y) < 10) { 
                         const dist = Math.abs(y - f0_y);
                         const factor = dist / 10;
                         const blended = val * factor + 255 * (1 - factor);
                         const idx = (y * imgWidth + x) * 4;
                         data[idx] = blended; data[idx+1] = blended; data[idx+2] = blended; data[idx+3] = 255;     
                     } else {
                         const idx = (y * imgWidth + x) * 4;
                         data[idx] = val; data[idx+1] = val; data[idx+2] = val; data[idx+3] = 255;
                     }
                 }
             }
         }
    }
    // putImageData ignores the context transform: the canvas covers only the visible part,
    // so the spectrogram image goes to the left edge of the canvas
    ctx.putImageData(imageData, 0, DIMENSIONS.rulerHeight);
};

export const drawGrid = (
    ctx: CanvasRenderingContext2D,
    viewStartTime: number,
    zoom: number,
    visibleWidth: number,
    containerHeight: number
) => {
    const visibleStartX = viewStartTime * zoom;
    const visibleEndX = visibleStartX + visibleWidth;

    // Frequency Grid
    ctx.strokeStyle = COLORS.gridLine;
    ctx.lineWidth = 1;
    ctx.font = '10px monospace';
    ctx.textBaseline = 'middle';
    // Semitone grid (equal temperament, A4 = 440 Hz) – only when lines are far enough apart
    {
        const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const pxPerSemitone = Math.abs(freqToY(440 * Math.pow(2, 1 / 12), containerHeight) - freqToY(440, containerHeight));
        if (pxPerSemitone >= 7) {
            const mLo = Math.ceil(69 + 12 * Math.log2(viewMinHz / 440));
            const mHi = Math.floor(69 + 12 * Math.log2(viewMaxHz / 440));
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            for (let m = mLo; m <= mHi; m++) {
                const f = 440 * Math.pow(2, (m - 69) / 12);
                const y = freqToY(f, containerHeight);
                if (y < DIMENSIONS.rulerHeight) continue;
                const pc = ((m % 12) + 12) % 12;
                const isC = pc === 0, isNatural = NAMES[pc].length === 1;
                ctx.beginPath();
                ctx.strokeStyle = isC ? '#cbd5e1' : (isNatural ? '#e5e7eb' : '#f1f5f9');
                ctx.lineWidth = 1;
                ctx.moveTo(visibleStartX, y);
                ctx.lineTo(visibleEndX, y);
                ctx.stroke();
                if (isC || (pxPerSemitone >= 13 && isNatural) || pxPerSemitone >= 22) {
                    ctx.fillStyle = COLORS.gridText;
                    ctx.font = '10px monospace';
                    ctx.fillText(`${NAMES[pc]}${Math.floor(m / 12) - 1}`, visibleStartX + 5, y - 5);
                }
            }
        }
    }
    // Octave lines (A) with Hz labels
    for (let f = 27.5; f <= 8000; f *= 2) {
        if (f < viewMinHz * 0.999 || f > viewMaxHz * 1.001) continue;
        const y = freqToY(f, containerHeight);
        ctx.beginPath();
        ctx.strokeStyle = '#9ca3af';
        ctx.lineWidth = 1;
        ctx.moveTo(visibleStartX, y);
        ctx.lineTo(visibleEndX, y);
        ctx.stroke();
        ctx.fillStyle = COLORS.gridText;
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${f}Hz`, visibleStartX + 40, y - 6);
    }

    // Time Ruler
    ctx.fillStyle = COLORS.rulerBackground; 
    ctx.fillRect(visibleStartX, 0, visibleWidth, DIMENSIONS.rulerHeight);
    ctx.beginPath();
    ctx.strokeStyle = COLORS.rulerLine; 
    ctx.moveTo(visibleStartX, DIMENSIONS.rulerHeight);
    ctx.lineTo(visibleEndX, DIMENSIONS.rulerHeight);
    ctx.stroke();

    const minPxPerTick = 100;
    const intervals = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60];
    let timeInterval = 60;
    for (const val of intervals) {
        if (val * zoom >= minPxPerTick) { timeInterval = val; break; }
    }

    ctx.fillStyle = COLORS.rulerText; 
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = '10px sans-serif';

    const startTimeTick = Math.floor(viewStartTime / timeInterval) * timeInterval;
    const endTimeTick = startTimeTick + (visibleWidth / zoom) + timeInterval;
    
    for (let t = startTimeTick; t <= endTimeTick; t += timeInterval) {
        const x = t * zoom;
        ctx.beginPath();
        ctx.strokeStyle = '#f3f4f6'; 
        ctx.moveTo(x, DIMENSIONS.rulerHeight);
        ctx.lineTo(x, containerHeight);
        ctx.stroke();

        ctx.beginPath();
        ctx.strokeStyle = '#9ca3af'; 
        ctx.moveTo(x, 0);
        ctx.lineTo(x, DIMENSIONS.rulerHeight - 5);
        ctx.stroke();

        const label = formatTime(t, timeInterval);
        ctx.fillText(label, x + 4, 4);
    }
};

export const drawNotes = (
    ctx: CanvasRenderingContext2D,
    notes: Note[],
    viewStartTime: number,
    zoom: number,
    visibleWidth: number,
    containerHeight: number,
    selectedNoteId?: string | null
) => {
    const visibleNotes = notes.filter(n => n.end > viewStartTime && n.start < viewStartTime + (visibleWidth/zoom));

    visibleNotes.forEach(note => {
        const x = note.start * zoom;
        const w = (note.end - note.start) * zoom;
        const yCenter = freqToY(note.pitch, containerHeight);
        const y = yCenter - (DIMENSIONS.noteHeight / 2);
        const visibleY = Math.max(DIMENSIONS.rulerHeight, y);
        
        const isSelected = note.id === selectedNoteId;

        // Fill
        ctx.fillStyle = isSelected ? COLORS.noteSelectedFill : COLORS.noteDefaultFill; 
        ctx.globalAlpha = 0.7;
        ctx.fillRect(x, visibleY, w, DIMENSIONS.noteHeight);
        
        // Border
        ctx.globalAlpha = 1.0;
        ctx.strokeStyle = isSelected ? COLORS.noteSelectedBorder : COLORS.noteDefaultBorder; 
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.strokeRect(x, visibleY, w, DIMENSIONS.noteHeight);

        // Clear segment boundaries: dark vertical bars at start and end, reaching beyond the note bar
        ctx.save();
        ctx.strokeStyle = isSelected ? '#1e3a8a' : '#1e40af';
        ctx.lineWidth = 2;
        const bTop = visibleY - 5, bBot = visibleY + DIMENSIONS.noteHeight + 5;
        ctx.beginPath();
        ctx.moveTo(x, bTop); ctx.lineTo(x, bBot);
        ctx.moveTo(x + w, bTop); ctx.lineTo(x + w, bBot);
        ctx.stroke();
        ctx.restore();

        // Note text (syllable) above the note bar
        if (note.text) {
            ctx.save();
            ctx.font = 'bold 14px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            const ty = Math.max(DIMENSIONS.rulerHeight + 14, visibleY - 7);
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.strokeText(note.text, x + w / 2, ty);
            ctx.fillStyle = isSelected ? '#1d4ed8' : '#111827';
            ctx.fillText(note.text, x + w / 2, ty);
            ctx.restore();
        }
    });
};

export const drawPitchCurve = (
    ctx: CanvasRenderingContext2D,
    pitchData: PitchFrame[],
    viewStartTime: number,
    zoom: number,
    visibleWidth: number,
    containerHeight: number
) => {
    ctx.fillStyle = COLORS.pitchCurve; 
    let pIdx = 0;
    while(pIdx < pitchData.length && pitchData[pIdx].timestamp < viewStartTime) pIdx++;
    
    for(let i = pIdx; i < pitchData.length; i++) {
        const frame = pitchData[i];
        if (frame.timestamp > viewStartTime + (visibleWidth/zoom)) break;
        if (!frame.hasPitch || frame.frequency < ANALYSIS.minPitch || frame.frequency > ANALYSIS.maxPitch) continue;
        
        const x = frame.timestamp * zoom;
        const y = freqToY(frame.frequency, containerHeight);
        if (y < DIMENSIONS.rulerHeight) continue;

        ctx.beginPath();
        ctx.arc(x, y, DIMENSIONS.pitchPointRadius, 0, Math.PI * 2);
        ctx.fill();
    }
};

export const drawCandidates = (
    ctx: CanvasRenderingContext2D,
    pitchData: PitchFrame[],
    viewStartTime: number,
    zoom: number,
    visibleWidth: number,
    containerHeight: number,
    selectionRange: [number, number]
) => {
      const [selStart, selEnd] = selectionRange;
      ctx.fillStyle = COLORS.candidate;
      
      let startIdx = 0;
      while(startIdx < pitchData.length && pitchData[startIdx].timestamp < selStart) startIdx++;

      for(let i = startIdx; i < pitchData.length; i++) {
          const frame = pitchData[i];
          if (frame.timestamp > selEnd) break;
          if (frame.timestamp < viewStartTime || frame.timestamp > viewStartTime + (visibleWidth/zoom)) continue;

          if (frame.candidates) {
            const x = frame.timestamp * zoom;
            frame.candidates.forEach(cand => {
                if (cand.frequency < ANALYSIS.minPitch || cand.frequency > ANALYSIS.maxPitch) return;
                const y = freqToY(cand.frequency, containerHeight);
                if (y < DIMENSIONS.rulerHeight) return;

                ctx.beginPath();
                ctx.arc(x, y, DIMENSIONS.candidateRadius, 0, Math.PI * 2);
                ctx.fill();
            });
          }
      }
};

export const drawSelection = (
    ctx: CanvasRenderingContext2D,
    selectionRange: [number, number],
    viewStartTime: number,
    zoom: number,
    visibleWidth: number,
    containerHeight: number
) => {
    const [start, end] = selectionRange;
    const x1 = start * zoom;
    const x2 = end * zoom;
    const visibleStartX = viewStartTime * zoom;
    const visibleEndX = visibleStartX + visibleWidth;
    
    // Draw background highlight
    if (x2 > visibleStartX && x1 < visibleEndX) {
        ctx.fillStyle = COLORS.selectionBackground; 
        ctx.fillRect(x1, 0, x2 - x1, containerHeight);
    }

    ctx.strokeStyle = COLORS.selectionBorder; 
    ctx.lineWidth = 1;
    
    if (x1 > visibleStartX && x1 < visibleEndX) {
        ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, containerHeight); ctx.stroke();
        const handleSize = 6;
        ctx.fillStyle = COLORS.selectionBorder;
        ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1 + handleSize, 0); ctx.lineTo(x1, handleSize); ctx.fill();
    }

    if (x2 > visibleStartX && x2 < visibleEndX) {
        ctx.beginPath(); ctx.moveTo(x2, 0); ctx.lineTo(x2, containerHeight); ctx.stroke();
        const handleSize = 6;
        ctx.fillStyle = COLORS.selectionBorder;
        ctx.beginPath(); ctx.moveTo(x2, 0); ctx.lineTo(x2 - handleSize, 0); ctx.lineTo(x2, handleSize); ctx.fill();
    }
};
