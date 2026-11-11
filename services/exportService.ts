
import { PitchFrame, Note, MixerState } from '../types';

/**
 * TONY CSV FORMATS:
 * Pitch: Timestamp(s), Frequency(Hz), Probability
 * Notes: Onset(s), Duration(s), Pitch(Hz)
 */

/**
 * SONIC VISUALISER (SVL) FORMAT:
 * XML based.
 * Pitch uses <point frame="..." value="..." />
 * Notes use <segment frame="..." duration="..." value="..." />
 */

export interface ProjectViewState {
    zoom: number;
    viewStartTime: number;
    currentTime: number;
    selectionRange: [number, number] | null;
}

export interface ProjectSettings {
    isLooping: boolean;
    playbackSpeed: number;
    showSpectrogram: boolean;
    showPitch: boolean;
    showNotes: boolean;
    mixerState: MixerState;
}

export const generateProjectJSON = (
    fileName: string,
    sampleRate: number,
    pitchData: PitchFrame[],
    notes: Note[],
    viewState?: ProjectViewState,
    settings?: ProjectSettings,
    textAudio?: { fileName: string; offset: number; active: boolean } | null
) => {
    return JSON.stringify({
        version: "1.2",
        fileName,
        sampleRate,
        pitchData,
        notes,
        viewState,
        settings,
        textAudio: textAudio || undefined
    }, null, 2);
};

export const generatePitchCSV = (pitchData: PitchFrame[]) => {
    let csv = "Time(s),Frequency(Hz),Probability\n";
    pitchData.forEach(p => {
        csv += `${p.timestamp.toFixed(6)},${p.frequency.toFixed(3)},${p.probability.toFixed(3)}\n`;
    });
    return csv;
};

const csvQuote = (t: string) => /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;

export const generateNotesCSV = (notes: Note[]) => {
    // Onset, Duration, Pitch (+ Text column if any note has text)
    const withText = notes.some(n => n.text);
    let csv = withText ? "Onset(s),Duration(s),Pitch(Hz),Text\n" : "Onset(s),Duration(s),Pitch(Hz)\n";
    notes.forEach(n => {
        const duration = n.end - n.start;
        csv += `${n.start.toFixed(6)},${duration.toFixed(6)},${n.pitch.toFixed(3)}`;
        if (withText) csv += `,${csvQuote(n.text || '')}`;
        csv += "\n";
    });
    return csv;
};

// Original Tony "Notes.txt" layout: onset <TAB> Hz <TAB> duration <TAB> text, no header
export const generateNotesTSV = (notes: Note[]) => {
    return notes.map(n =>
        `${n.start.toFixed(6)}\t${n.pitch.toFixed(6)}\t${(n.end - n.start).toFixed(6)}\t${(n.text || '').replace(/[\t\r\n]+/g, ' ')}`
    ).join("\n") + (notes.length ? "\n" : "");
};

export const generateSVL = (
    pitchData: PitchFrame[],
    notes: Note[],
    sampleRate: number,
    layerName: string
) => {
    // Basic SVL Header
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE sv>
<sv>
  <data>
    <model id="1" name="${layerName}" sampleRate="${sampleRate}" start="0" end="${pitchData.length > 0 ? Math.ceil(pitchData[pitchData.length-1].timestamp * sampleRate) : 0}" type="sparse" dimensions="1" resolution="1" notifyOnAdd="true" dataset="2" subtype="rectangular" minimum="0" maximum="1200" units="Hz" />
    <dataset id="2" dimensions="1">`;

    // Add Pitch Points
    pitchData.forEach(p => {
        if (p.hasPitch && p.frequency > 0) {
            const frame = Math.round(p.timestamp * sampleRate);
            // SVL uses label for probability sometimes, but let's stick to standard value
            xml += `\n      <point frame="${frame}" value="${p.frequency}" label="${p.probability.toFixed(2)}" />`;
        }
    });

    // Add Notes (Segments)
    xml += `\n    </dataset>`;

    if (notes.length > 0) {
        xml += `\n    <model id="3" name="Notes" sampleRate="${sampleRate}" start="0" end="0" type="sparse" dimensions="1" resolution="1" notifyOnAdd="true" dataset="4" subtype="segment" minimum="0" maximum="1200" units="Hz" />
    <dataset id="4" dimensions="1">`;
        notes.forEach(n => {
            const frame = Math.round(n.start * sampleRate);
            const durationFrames = Math.round((n.end - n.start) * sampleRate);
            const label = (n.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            xml += `\n      <segment frame="${frame}" duration="${durationFrames}" value="${n.pitch}" label="${label}" />`;
        });
        xml += `\n    </dataset>`;
    }

    xml += `\n  </data>\n</sv>`;
    return xml;
};

// --- PARSING ---

export const parseProjectJSON = (jsonString: string) => {
    try {
        const data = JSON.parse(jsonString);
        // Basic validation
        if (!data.pitchData || !Array.isArray(data.pitchData)) throw new Error("Invalid Project File");
        return data;
    } catch (e) {
        console.error(e);
        return null;
    }
};

// Split one line; handles "quoted" fields for comma-separated data.
const splitLine = (line: string, delim: string): string[] => {
    if (delim === '\t') return line.split('\t');
    const out: string[] = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
            if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (c === '"') q = false;
            else cur += c;
        } else if (c === '"') q = true;
        else if (c === delim) { out.push(cur); cur = ''; }
        else cur += c;
    }
    out.push(cur);
    return out;
};

export const parseCSV = (csvString: string, type: 'pitch' | 'note'): any[] => {
    const lines = csvString.replace(/^\uFEFF/, '').split(/\r?\n/);
    const result: any[] = [];
    const first = lines.find(l => l.trim()) || '';
    const delim = first.includes('\t') ? '\t' : ',';

    // Header present? (letters in the first line)
    let startIndex = 0;
    let col = { onset: 0, dur: 1, pitch: 2, text: 3 };
    if (type === 'note' && delim === '\t') col = { onset: 0, pitch: 1, dur: 2, text: 3 }; // Tony Notes.txt order
    if (lines[0] && /[a-zA-Z]/.test(lines[0]) && !/^[\d.\-\s]+[\t,]/.test(lines[0])) {
        startIndex = 1;
        const names = splitLine(lines[0], delim).map(h => h.trim().toLowerCase());
        const find = (re: RegExp) => names.findIndex(h => re.test(h));
        const o = find(/onset|start|time/), d = find(/dur/), p = find(/pitch|freq|hz/), t = find(/text|lyric|label|syll/);
        if (o >= 0) col.onset = o;
        if (d >= 0) col.dur = d;
        if (p >= 0) col.pitch = p;
        if (t >= 0) col.text = t;
    }

    for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const parts = splitLine(line, delim);
        if (parts.length < 2) continue;

        if (type === 'pitch') {
            const t = parseFloat(parts[0]);
            const f = parseFloat(parts[1]);
            const p = parts[2] ? parseFloat(parts[2]) : 1.0;
            if (!isNaN(t)) {
                result.push({
                    timestamp: t,
                    frequency: isNaN(f) ? 0 : f,
                    probability: p,
                    hasPitch: f > 0,
                    candidates: []
                });
            }
        } else {
            const start = parseFloat(parts[col.onset]);
            const dur = parseFloat(parts[col.dur]);
            const pitch = parseFloat(parts[col.pitch]);
            const text = (parts[col.text] ?? '').trim();
            if (!isNaN(start) && !isNaN(dur)) {
                const note: any = {
                    id: crypto.randomUUID(),
                    start: start,
                    end: start + dur,
                    pitch: isNaN(pitch) ? 0 : pitch,
                    state: 'default'
                };
                if (text) note.text = text;
                result.push(note);
            }
        }
    }
    return result;
};
