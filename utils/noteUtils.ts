
import { Note, PitchFrame } from "../types";
import { YIN_HOP_SIZE } from "../services/yin";

// Snap time to nearest analysis frame
// Hop (samples) of the pitch frames currently in use; set by the app whenever the pitch data change
let snapHopSamples = YIN_HOP_SIZE;
export const setSnapHop = (hopSamples: number) => { if (hopSamples > 0) snapHopSamples = hopSamples; };

// Hop (samples) of a pitch track, estimated from its time stamps (median spacing)
export const estimateHopSamples = (frames: { timestamp: number }[], sampleRate: number): number => {
    if (!sampleRate || frames.length < 3) return YIN_HOP_SIZE;
    const diffs: number[] = [];
    const n = Math.min(frames.length - 1, 2000);
    for (let i = 0; i < n; i++) { const d = frames[i + 1].timestamp - frames[i].timestamp; if (d > 0) diffs.push(d); }
    if (diffs.length === 0) return YIN_HOP_SIZE;
    diffs.sort((a, b) => a - b);
    return Math.max(16, Math.round(diffs[diffs.length >> 1] * sampleRate));
};

export const snapTime = (time: number, sampleRate: number): number => {
    if (!sampleRate) return time;
    const frameDur = snapHopSamples / sampleRate;
    return Math.round(time / frameDur) * frameDur;
};

// Calculate median pitch from frames
export const calculateMedianPitch = (frames: PitchFrame[]): number => {
  const freqs = frames
    .filter(f => f.hasPitch && f.frequency > 0)
    .map(f => f.frequency)
    .sort((a, b) => a - b);
  
  if (freqs.length === 0) return 0;
  
  const mid = Math.floor(freqs.length / 2);
  if (freqs.length % 2 === 0) {
      return (freqs[mid - 1] + freqs[mid]) / 2;
  }
  return freqs[mid];
};

// Split a note into two at a specific time
export const splitNote = (
    note: Note, 
    splitTime: number, 
    pitchData: PitchFrame[]
): Note[] | null => {
    if (splitTime <= note.start + 0.01 || splitTime >= note.end - 0.01) return null;

    const leftFrames = pitchData.filter(
        f => f.timestamp >= note.start && f.timestamp <= splitTime
    );
    let leftPitch = calculateMedianPitch(leftFrames);
    if (leftPitch === 0) leftPitch = note.pitch;

    const rightFrames = pitchData.filter(
        f => f.timestamp >= splitTime && f.timestamp <= note.end
    );
    let rightPitch = calculateMedianPitch(rightFrames);
    if (rightPitch === 0) rightPitch = note.pitch;

    const leftNote: Note = {
        ...note,
        id: crypto.randomUUID(),
        end: splitTime,
        pitch: leftPitch,
        text: note.text
    };

    const rightNote: Note = {
        ...note,
        id: crypto.randomUUID(),
        start: splitTime,
        pitch: rightPitch,
        text: undefined
    };

    return [leftNote, rightNote];
};

// Merge a group of notes (any gaps between them are filled) into one note.
// Pitch = median of the pitch track over the new extent; text = first non-empty text.
export const mergeNotes = (group: Note[], pitchData: PitchFrame[]): Note => {
    const sorted = [...group].sort((a, b) => a.start - b.start);
    const start = sorted[0].start;
    const end = Math.max(...sorted.map(n => n.end));
    let pitch = calculateMedianPitch(pitchData.filter(f => f.timestamp >= start && f.timestamp <= end));
    if (!(pitch > 0)) {
        let w = 0, acc = 0;
        sorted.forEach(n => { const d = n.end - n.start; w += d; acc += d * n.pitch; });
        pitch = w > 0 ? acc / w : sorted[0].pitch;
    }
    const text = sorted.find(n => n.text)?.text;
    return { id: crypto.randomUUID(), start, end, pitch, state: 'default', ...(text ? { text } : {}) };
};

// Handle smart resizing (pushing neighbors)
export const resizeNoteWithPush = (
    allNotes: Note[], 
    targetNoteId: string, 
    newStart: number, 
    newEnd: number, 
    pitchData: PitchFrame[]
): Note[] => {
    const targetNote = allNotes.find(n => n.id === targetNoteId);
    if (!targetNote) return allNotes;

    const otherNotes = allNotes.filter(n => n.id !== targetNoteId);
    const modifiedNotes: Note[] = [];
    const notesToDelete: string[] = [];

    // Push Neighbors
    otherNotes.forEach(neighbor => {
        let nStart = neighbor.start;
        let nEnd = neighbor.end;
        let changed = false;

        if (newEnd > nStart + 0.001 && newStart < nEnd - 0.001) {
            changed = true;
            if (nStart >= targetNote.start && nEnd > targetNote.end) {
                 nStart = newEnd;
            } else if (nEnd <= targetNote.end && nStart < targetNote.start) {
                 nEnd = newStart;
            } else {
                 if (nStart < newStart) nEnd = newStart;
                 else nStart = newEnd;
            }
        }

        if (changed) {
            if (nEnd - nStart < 0.01) {
                notesToDelete.push(neighbor.id);
            } else {
                modifiedNotes.push({ ...neighbor, start: nStart, end: nEnd });
            }
        }
    });

    // Recalculate Neighbors
    const finalOtherNotes = otherNotes.map(n => {
        const mod = modifiedNotes.find(mn => mn.id === n.id);
        if (notesToDelete.includes(n.id)) return null;
        if (mod) {
            const frames = pitchData.filter(f => f.timestamp >= mod.start && f.timestamp <= mod.end);
            const pitch = calculateMedianPitch(frames);
            return { ...mod, pitch: pitch > 0 ? pitch : mod.pitch };
        }
        return n;
    }).filter((n): n is Note => n !== null);

    // Recalculate Target
    const targetFrames = pitchData.filter(f => f.timestamp >= newStart && f.timestamp <= newEnd);
    const targetPitch = calculateMedianPitch(targetFrames);

    const updatedTargetNote: Note = {
        ...targetNote,
        start: newStart,
        end: newEnd,
        pitch: targetPitch > 0 ? targetPitch : targetNote.pitch
    };

    return [...finalOtherNotes, updatedTargetNote].sort((a, b) => a.start - b.start);
};

// Get context range for a note (neighboring area)
export const getNoteContextRange = (note: Note, paddingSeconds: number): [number, number] => {
    let start = note.start - paddingSeconds;
    let end = note.end + paddingSeconds;
    
    return [Math.max(0, start), end];
};


// Carry note texts over to a freshly segmented set of notes (largest time overlap wins).
export const inheritNoteTexts = (oldNotes: Note[], newNotes: Note[]): Note[] => {
    const withText = oldNotes.filter(n => n.text && n.text.length > 0);
    if (withText.length === 0) return newNotes;
    const used = new Set<string>();
    return newNotes.map(nn => {
        let best: Note | null = null;
        let bestOv = 0;
        for (const o of withText) {
            if (used.has(o.id)) continue;
            const ov = Math.min(nn.end, o.end) - Math.max(nn.start, o.start);
            if (ov > bestOv) { bestOv = ov; best = o; }
        }
        if (best && bestOv > 0.5 * Math.min(nn.end - nn.start, best.end - best.start)) {
            used.add(best.id);
            return { ...nn, text: best.text };
        }
        return nn;
    });
};

// Close gaps between neighbouring notes inside a time range: the end of the earlier and the
// start of the later note both move to the middle of the gap. Only gaps up to maxGap (s) are
// closed; only notes whose midpoint lies in [range[0], range[1]] are considered.
export const closeNoteGaps = (notes: Note[], range: [number, number], maxGap: number): Note[] => {
  const sorted = [...notes].sort((a, b) => a.start - b.start).map(n => ({ ...n }));
  const inRange = (n: Note) => (n.start + n.end) / 2 >= range[0] && (n.start + n.end) / 2 <= range[1];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (!inRange(a) || !inRange(b)) continue;
    const gap = b.start - a.end;
    if (gap > 1e-9 && gap <= maxGap) {
      const mid = (a.end + b.start) / 2;
      a.end = mid;
      b.start = mid;
    }
  }
  return sorted;
};
