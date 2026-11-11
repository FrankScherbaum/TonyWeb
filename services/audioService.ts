

import { MixerState, PitchFrame, Note } from "../types";

export class AudioService {
  private context: AudioContext;
  private source: AudioBufferSourceNode | null = null;
  private anchorTime: number = 0; // Context time when play started
  private startOffset: number = 0; // Where in the buffer we started
  private playbackRate: number = 1.0;
  private isPlaying: boolean = false;
  private pauseTime: number = 0; // For returning time when stopped
  // Optional alternative recording (e.g. headset mic) used for the 'Audio' channel
  private altBuffer: AudioBuffer | null = null;
  private altOffset: number = 0; // seconds: altTime = mainTime + altOffset
  private useAlt: boolean = false;

  // Mixer Nodes
  private masterGain: GainNode;
  
  private originalGain: GainNode;
  private pitchGain: GainNode;
  private notesGain: GainNode;

  // Effects
  private reverbNode: ConvolverNode;

  // Panners
  private pitchPanner: StereoPannerNode;
  private notesPanner: StereoPannerNode;

  // Synth Nodes (f0 Curve)
  private synthOsc: OscillatorNode | null = null;
  private synthGain: GainNode | null = null;
  private vibratoOsc: OscillatorNode | null = null;
  private vibratoGain: GainNode | null = null;

  // Synth Nodes (Notes) - We track active note oscillators to stop them
  private activeNoteNodes: AudioNode[] = [];

  constructor() {
    // Optimization: latencyHint 'playback' encourages the browser to use high-quality resampling/time-stretching algorithms
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.context = new AudioContextClass({ latencyHint: 'playback' });
    
    // Setup Master Mixer
    this.masterGain = this.context.createGain();
    this.masterGain.connect(this.context.destination);

    // Setup Reverb (Convolver)
    this.reverbNode = this.context.createConvolver();
    this.reverbNode.buffer = this.createReverbImpulse(2.0); // 2 seconds tail
    const reverbMix = this.context.createGain();
    reverbMix.gain.value = 0.3; // 30% Wet
    this.reverbNode.connect(reverbMix);
    reverbMix.connect(this.masterGain);

    // Track Gains
    this.originalGain = this.context.createGain();
    this.pitchGain = this.context.createGain();
    this.notesGain = this.context.createGain();

    // Setup Panners (Spatial Separation)
    this.pitchPanner = this.context.createStereoPanner();
    this.notesPanner = this.context.createStereoPanner();
    
    // Settings: f0 Left, Notes Right
    this.pitchPanner.pan.value = -0.3; 
    this.notesPanner.pan.value = 0.3;

    // Routing
    // Original -> Master (Dry)
    this.originalGain.connect(this.masterGain);
    
    // Pitch -> Panner -> Master & Reverb
    this.pitchGain.connect(this.pitchPanner);
    this.pitchPanner.connect(this.masterGain);
    this.pitchPanner.connect(this.reverbNode);
    
    // Notes -> Panner -> Master & Reverb
    this.notesGain.connect(this.notesPanner);
    this.notesPanner.connect(this.masterGain);
    this.notesPanner.connect(this.reverbNode);
  }

  // Create a synthetic Impulse Response for reverb
  private createReverbImpulse(duration: number): AudioBuffer {
    const rate = this.context.sampleRate;
    const length = rate * duration;
    const impulse = this.context.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
        // Exponential decay noise
        const n = i / length;
        const decay = Math.pow(1 - n, 3); 
        left[i] = (Math.random() * 2 - 1) * decay;
        right[i] = (Math.random() * 2 - 1) * decay;
    }
    return impulse;
  }

  get currentTime() {
    return this.getCurrentTime();
  }

  updateMixer(state: MixerState) {
    const now = this.context.currentTime;
    const rampTime = 0.1;
    
    const origVol = state.originalEnabled ? state.originalVolume : 0.0;
    const pitchVol = state.pitchEnabled ? state.pitchVolume : 0.0;
    const notesVol = state.notesEnabled ? state.notesVolume : 0.0;

    this.originalGain.gain.setTargetAtTime(origVol, now, rampTime);
    this.pitchGain.gain.setTargetAtTime(pitchVol, now, rampTime); 
    this.notesGain.gain.setTargetAtTime(notesVol, now, rampTime);
  }

  async decodeAudio(file: File): Promise<AudioBuffer> {
    const arrayBuffer = await file.arrayBuffer();
    return await this.context.decodeAudioData(arrayBuffer);
  }

  setAlternateAudio(buffer: AudioBuffer | null, offset: number, use: boolean) {
    this.altBuffer = buffer;
    this.altOffset = offset;
    this.useAlt = use && !!buffer;
  }

  play(
      buffer: AudioBuffer, 
      pitchData: PitchFrame[], 
      notes: Note[], 
      startOffset: number = 0, 
      duration?: number,
      playbackRate: number = 1.0
  ) {
    if (this.isPlaying) this.stop();

    if (this.context.state === 'suspended') {
      this.context.resume();
    }

    this.anchorTime = this.context.currentTime;
    this.startOffset = startOffset;
    this.playbackRate = playbackRate;
    this.isPlaying = true;

    // 1. Setup Original Audio Source
    this.source = this.context.createBufferSource();
    
    // STRICT ORDERING: 
    // 1. Assign Buffer
    const useAlt = this.useAlt && !!this.altBuffer;
    this.source.buffer = useAlt ? this.altBuffer : buffer;

    // 2. Enable Pitch Preservation (Time Stretching)
    // We explicitly set this property before touching playbackRate
    const src = this.source as any;
    src.preservesPitch = true;
    src.mozPreservesPitch = true;
    src.webkitPreservesPitch = true;
    
    // 3. Set Playback Rate
    this.source.playbackRate.value = playbackRate;

    this.source.connect(this.originalGain);
    
    // source.start takes (when, offset, duration)
    let srcOffset = startOffset + (useAlt ? this.altOffset : 0);
    let srcDuration = duration;
    let when = 0;
    if (srcOffset < 0) {
      // alternative recording starts later than main: delay the start
      when = this.context.currentTime + (-srcOffset) / playbackRate;
      if (srcDuration !== undefined) srcDuration = Math.max(0, srcDuration + srcOffset);
      srcOffset = 0;
    }
    if (srcDuration !== undefined) {
      this.source.start(when, srcOffset, srcDuration);
    } else {
      this.source.start(when, srcOffset);
    }

    // 2. Setup Pitch Synthesizer (Continuous)
    if (pitchData && pitchData.length > 0) {
      this.startPitchSynth(pitchData, startOffset, duration);
    }

    // 3. Setup Note Synthesizer (Discrete)
    if (notes && notes.length > 0) {
        this.startNoteSynth(notes, startOffset, duration);
    }
  }

  private startPitchSynth(pitchData: PitchFrame[], startOffset: number, duration?: number) {
    const now = this.context.currentTime;
    // Calculate end time in Buffer Domain
    const endBufferTime = duration !== undefined ? startOffset + duration : Infinity;
    
    // Calculate stop time in Context Domain (Wall Clock)
    // Wall Duration = Buffer Duration / Rate
    const wallDuration = duration !== undefined ? duration / this.playbackRate : undefined;
    const stopTime = wallDuration !== undefined ? now + wallDuration : undefined;
    
    // Sound Design: Smooth "Humming" (Triangle)
    // We make this softer (lower cutoff) to contrast with the bright notes
    this.synthOsc = this.context.createOscillator();
    this.synthOsc.type = 'triangle'; 

    // Vibrato
    this.vibratoOsc = this.context.createOscillator();
    this.vibratoOsc.frequency.value = 5.0; 
    this.vibratoGain = this.context.createGain();
    this.vibratoGain.gain.value = 3; // Reduced vibrato depth slightly
    
    this.vibratoOsc.connect(this.vibratoGain);
    this.vibratoGain.connect(this.synthOsc.detune);
    this.vibratoOsc.start(0);

    // Filter - Lower cutoff to make it background/bass-like
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400; // Lowered from 600

    this.synthGain = this.context.createGain();
    this.synthGain.gain.setValueAtTime(0, now); // Initialize to 0

    // Chain
    this.synthOsc.connect(filter);
    filter.connect(this.synthGain);
    this.synthGain.connect(this.pitchGain);

    // Scheduling
    pitchData.forEach((frame) => {
        const frameTime = frame.timestamp;
        if (frameTime < startOffset) return;
        if (frameTime > endBufferTime) return;

        // MATH: We must map "Buffer Time" to "Context Time"
        const timeFromNow = (frameTime - startOffset) / this.playbackRate;
        const scheduleTime = this.anchorTime + timeFromNow;
        
        if (scheduleTime < now) return;

        if (frame.hasPitch && frame.frequency > 0) {
            // Using linearRamp for more stable pitch tracking at slow speeds
            this.synthOsc?.frequency.linearRampToValueAtTime(frame.frequency, scheduleTime);
            this.synthGain?.gain.linearRampToValueAtTime(0.7, scheduleTime);
        } else {
            this.synthGain?.gain.linearRampToValueAtTime(0.0, scheduleTime);
        }
    });

    this.synthOsc.start(0);
    if (stopTime !== undefined) {
        this.synthOsc.stop(stopTime);
        this.vibratoOsc?.stop(stopTime);
    }
  }

  // --- PULSE / CLARINET NOTE ENGINE ---
  // Replaces the Formant Vocal engine for a snappier, clearer sound
  private createPulseNotePatch(freq: number, startTime: number, dur: number): AudioNode[] {
     const t = startTime;
     
     // 1. Source: Square Wave (Clarinet/Gameboy style) - Very distinct pitch
     const osc = this.context.createOscillator();
     osc.type = 'square';
     osc.frequency.setValueAtTime(freq, t);

     // 2. Filter: Lowpass to round off the harsh edges, but keep it bright
     const filter = this.context.createBiquadFilter();
     filter.type = 'lowpass';
     filter.frequency.value = 2000;
     filter.Q.value = 1;

     // 3. Envelope
     const env = this.context.createGain();
     env.gain.setValueAtTime(0, t);
     
     // ADSR
     // Fast Attack for Snappy Onset
     const attack = Math.min(0.015, dur * 0.1); 
     const decay = Math.min(0.1, dur * 0.3);
     const release = Math.min(0.05, dur * 0.2);
     const sustainLevel = 0.6;
     
     env.gain.linearRampToValueAtTime(0.8, t + attack); // Peak volume
     env.gain.linearRampToValueAtTime(sustainLevel, t + attack + decay); // Decay to sustain
     env.gain.setValueAtTime(sustainLevel, t + dur - release);
     env.gain.linearRampToValueAtTime(0, t + dur);

     // Connect
     osc.connect(filter);
     filter.connect(env);
     env.connect(this.notesGain);

     osc.start(t);
     osc.stop(t + dur);

     return [osc, env, filter];
  }

  private startNoteSynth(notes: Note[], startOffset: number, duration?: number) {
      const now = this.context.currentTime;
      const endBufferTime = duration !== undefined ? startOffset + duration : Infinity;

      this.activeNoteNodes = [];

      notes.forEach(note => {
          if (note.end < startOffset) return;
          if (note.start > endBufferTime) return;

          // Map Buffer Time to Context Time with Speed Scaling
          const relStart = (note.start - startOffset) / this.playbackRate;
          const relEnd = (note.end - startOffset) / this.playbackRate;
          
          // Absolute Context Time
          const noteStartTime = Math.max(now, this.anchorTime + relStart);
          const noteEndTime = this.anchorTime + relEnd;
          
          if (noteEndTime < now) return;
          
          let wallDur = noteEndTime - noteStartTime;
          if (wallDur < 0.05) wallDur = 0.05; 

          // Create a voice
          // Note: Pitch remains the same (note.pitch)
          const nodes = this.createPulseNotePatch(note.pitch, noteStartTime, wallDur);
          this.activeNoteNodes.push(...nodes);
      });
  }

  stop() {
    if (this.source) {
      try { 
          if (this.source instanceof AudioScheduledSourceNode) {
            this.source.stop(); 
          }
      } catch (e) {}
      this.source.disconnect();
      this.source = null;
    }

    // Cleanup f0 synth
    if (this.synthOsc) {
        try { this.synthOsc.stop(); } catch (e) {}
        this.synthOsc.disconnect();
        this.synthOsc = null;
    }
    if (this.vibratoOsc) {
        try { this.vibratoOsc.stop(); } catch (e) {}
        this.vibratoOsc.disconnect();
        this.vibratoOsc = null;
    }

    // Cleanup Note nodes
    this.activeNoteNodes.forEach(node => {
        try { 
            if (node instanceof AudioScheduledSourceNode) {
                node.stop();
            }
        } catch(e) {}
        node.disconnect();
    });
    this.activeNoteNodes = [];

    // Clear internal gain nodes if needed or reset
    if (this.vibratoGain) { this.vibratoGain.disconnect(); this.vibratoGain = null; }
    if (this.synthGain) { this.synthGain.disconnect(); this.synthGain = null; }

    this.isPlaying = false;
    // Calculate exact buffer position where we stopped
    // elapsedBufferTime = (ctx.currentTime - anchorTime) * rate
    const elapsed = (this.context.currentTime - this.anchorTime) * this.playbackRate;
    this.pauseTime = this.startOffset + elapsed;
  }

  getCurrentTime(): number {
    if (!this.isPlaying) return this.pauseTime;
    // elapsedBufferTime = (ctx.currentTime - anchorTime) * rate
    const elapsed = (this.context.currentTime - this.anchorTime) * this.playbackRate;
    return this.startOffset + elapsed;
  }
}

export const audioService = new AudioService();
