
export interface PitchCandidate {
  frequency: number;
  probability: number;
}

export interface PitchFrame {
  timestamp: number;
  frequency: number;
  probability: number;
  hasPitch: boolean;
  candidates?: PitchCandidate[];
}

export interface Note {
  id: string;
  start: number;
  end: number;
  pitch: number; // Frequency in Hz
  state?: 'selected' | 'default'; // For future editing
  text?: string; // Lyrics / syllable text for this note
}

export interface AudioState {
  buffer: AudioBuffer | null;
  fileName: string | null;
  duration: number;
}

export interface AnalysisState {
  isAnalyzing: boolean;
  progress: number;
  pitchData: PitchFrame[];
  notes: Note[]; // Added notes array
}

export interface HistoryState {
  pitchData: PitchFrame[];
  notes: Note[];
}

export interface ViewState {
  zoom: number; // Pixels per second
  scrollLeft: number;
  isPlaying: boolean;
  isLooping: boolean;
  selectionRange: [number, number] | null;
  currentTime: number;
}

export interface MixerState {
  originalEnabled: boolean;
  originalVolume: number;
  pitchEnabled: boolean;
  pitchVolume: number;
  notesEnabled: boolean; 
  notesVolume: number;
}

export type AudioSource = 'main' | 'text';

export interface SpectrogramData {
  width: number;
  height: number;
  magnitude2d: Float32Array[]; // Array of arrays for easier access, or flat buffer
  maxMagnitude: number;
  sampleRate?: number; // needed to map bins to Hz
}
