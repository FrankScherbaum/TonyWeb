

import React, { useState, useRef, useEffect } from 'react';
import { Volume2, VolumeX, Music, Mic, Activity, Waves, Eye, EyeOff, Gauge } from 'lucide-react';
import { MixerState, AudioSource } from '../types';

interface MixerProps {
  mixerState: MixerState;
  showSpectrogram: boolean;
  onToggleSpectrogram: () => void;
  showPitch: boolean;
  onTogglePitch: () => void;
  showNotes: boolean;
  onToggleNotes: () => void;
  onUpdate: (updates: Partial<MixerState>) => void;
  playbackSpeed: number;
  onPlaybackSpeedChange: (speed: number) => void;
  freqRange?: [number, number];
  onFreqRangeChange?: (r: [number, number]) => void;
  // Optional second recording (headset mic) for listening
  textAudioName?: string | null;
  audioSource?: AudioSource;
  onAudioSourceChange?: (s: AudioSource) => void;
  textAudioOffset?: number;
  onTextAudioOffsetChange?: (o: number) => void;
}

const Mixer: React.FC<MixerProps> = ({ 
  mixerState, 
  showSpectrogram, onToggleSpectrogram,
  showPitch, onTogglePitch,
  showNotes, onToggleNotes,
  onUpdate,
  playbackSpeed,
  onPlaybackSpeedChange,
  freqRange = [50, 5000],
  onFreqRangeChange,
  textAudioName = null,
  audioSource = 'main',
  onAudioSourceChange,
  textAudioOffset = 0,
  onTextAudioOffsetChange
}) => {
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [minDraft, setMinDraft] = useState(String(freqRange[0]));
  const [maxDraft, setMaxDraft] = useState(String(freqRange[1]));
  useEffect(() => { setMinDraft(String(freqRange[0])); setMaxDraft(String(freqRange[1])); }, [freqRange[0], freqRange[1]]);
  const commitRange = () => {
    let lo = parseFloat(minDraft), hi = parseFloat(maxDraft);
    if (isNaN(lo) || isNaN(hi)) { setMinDraft(String(freqRange[0])); setMaxDraft(String(freqRange[1])); return; }
    lo = Math.max(20, Math.min(lo, 10000));
    hi = Math.min(20000, Math.max(hi, lo * 1.5)); // at least ~7 semitones visible
    setMinDraft(String(Math.round(lo))); setMaxDraft(String(Math.round(hi)));
    if (Math.round(lo) !== freqRange[0] || Math.round(hi) !== freqRange[1]) onFreqRangeChange?.([Math.round(lo), Math.round(hi)]);
  };
  const speedMenuRef = useRef<HTMLDivElement>(null);

  // Close speed menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (speedMenuRef.current && !speedMenuRef.current.contains(event.target as Node)) {
        setShowSpeedMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  
  const ChannelStrip = ({ 
    enabled, 
    volume,
    onToggle, 
    onVolumeChange,
    label, 
    icon: Icon,
    visualToggle,
    onVisualToggle
  }: { 
    enabled: boolean; 
    volume: number;
    onToggle: () => void; 
    onVolumeChange: (val: number) => void;
    label: string; 
    icon: any;
    visualToggle?: boolean;
    onVisualToggle?: () => void;
  }) => (
    <div className={`
      flex items-center gap-2 px-3 py-2 rounded-md border shadow-sm transition-all
      ${enabled 
        ? 'bg-gray-100 border-gray-300' 
        : 'bg-white text-gray-400 border-gray-200'}
    `}>
        {/* Visual Toggle (Eye) */}
        {onVisualToggle !== undefined && (
            <button
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onVisualToggle(); }}
                className={`p-1 rounded hover:bg-gray-200 focus:outline-none transition-colors ${visualToggle ? 'text-gray-700' : 'text-gray-400'}`}
                title={visualToggle ? "Hide Visuals" : "Show Visuals"}
            >
                {visualToggle ? <Eye size={16} /> : <EyeOff size={16} />}
            </button>
        )}

        {/* Audio Toggle Button */}
        <button
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
            className={`
                flex items-center gap-2 px-2 py-1 rounded-sm text-sm font-semibold focus:outline-none transition-colors
                ${enabled ? 'text-gray-800' : 'text-gray-400'}
            `}
            title={enabled ? "Mute" : "Unmute"}
        >
            <Icon size={16} />
            <span className="w-20 text-left truncate">{label}</span>
            {enabled ? <Volume2 size={14} className="opacity-70" /> : <VolumeX size={14} className="opacity-50" />}
        </button>

        {/* Volume Slider */}
        <div className="flex items-center gap-2 border-l border-gray-300 pl-2">
            <input 
                type="range" 
                min="0" 
                max="1" 
                step="0.01" 
                value={volume}
                disabled={!enabled}
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                className="w-20 h-2 bg-gray-300 rounded-lg appearance-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed accent-blue-600 hover:accent-blue-700"
            />
        </div>
    </div>
  );

  return (
    <div className="h-16 bg-gray-50 border-t border-gray-300 flex items-center justify-center px-4 gap-4 z-20">
      
      {/* Speed Control (New Location) */}
      <div className="relative" ref={speedMenuRef}>
          <button 
             onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setShowSpeedMenu(!showSpeedMenu); }}
             className="flex items-center gap-2 px-3 py-2 rounded-md border shadow-sm bg-white border-gray-200 text-gray-700 hover:bg-gray-50 focus:outline-none transition-all"
             title="Playback Speed"
          >
             <Gauge size={18} />
             <span className="text-sm font-semibold w-8 text-center">{playbackSpeed}x</span>
          </button>
          {showSpeedMenu && (
              <div className="absolute bottom-full left-0 mb-2 w-24 bg-white border border-gray-200 rounded-md shadow-lg py-1 z-50 text-sm">
                  {[0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0].map(speed => (
                      <button
                        key={speed}
                        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onPlaybackSpeedChange(speed); setShowSpeedMenu(false); }}
                        className={`w-full text-left px-3 py-1.5 hover:bg-blue-50 ${playbackSpeed === speed ? 'bg-blue-100 font-bold' : ''}`}
                      >
                        {speed}x
                      </button>
                  ))}
              </div>
          )}
      </div>

      <div className="w-px h-8 bg-gray-300 mx-2"></div>

      {textAudioName && onAudioSourceChange && (
        <>
          <div className="flex items-center gap-2 text-xs" title={`Headset recording: ${textAudioName}`}>
            <div className="flex rounded-md overflow-hidden border border-gray-300 shadow-sm">
              <button
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onAudioSourceChange('main'); }}
                className={`px-2 py-1.5 ${audioSource === 'main' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              >Main</button>
              <button
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onAudioSourceChange('text'); }}
                className={`px-2 py-1.5 border-l border-gray-300 ${audioSource === 'text' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              >Headset</button>
            </div>
            <label className="flex items-center gap-1 text-gray-600" title="Time offset of the headset recording (seconds). Positive: headset recording is later than the main one.">
              Offset
              <input
                type="number" step="0.01"
                className="w-16 border rounded px-1 py-0.5 text-right font-mono"
                value={textAudioOffset}
                onChange={(e) => { const v = parseFloat(e.target.value); onTextAudioOffsetChange?.(isNaN(v) ? 0 : v); }}
              />s
            </label>
          </div>
          <div className="w-px h-8 bg-gray-300 mx-2"></div>
        </>
      )}

      <ChannelStrip 
        enabled={mixerState.originalEnabled} 
        volume={mixerState.originalVolume}
        onToggle={() => onUpdate({ originalEnabled: !mixerState.originalEnabled })} 
        onVolumeChange={(v) => onUpdate({ originalVolume: v })}
        label="Audio"
        icon={Mic}
      />
      
      <ChannelStrip 
        enabled={mixerState.pitchEnabled} 
        volume={mixerState.pitchVolume}
        onToggle={() => onUpdate({ pitchEnabled: !mixerState.pitchEnabled })} 
        onVolumeChange={(v) => onUpdate({ pitchVolume: v })}
        label="Pitch"
        icon={Activity}
        visualToggle={showPitch}
        onVisualToggle={onTogglePitch}
      />

      <ChannelStrip 
        enabled={mixerState.notesEnabled} 
        volume={mixerState.notesVolume}
        onToggle={() => onUpdate({ notesEnabled: !mixerState.notesEnabled })} 
        onVolumeChange={(v) => onUpdate({ notesVolume: v })}
        label="Notes"
        icon={Music}
        visualToggle={showNotes}
        onVisualToggle={onToggleNotes}
      />

      <div className="w-px h-8 bg-gray-300 mx-2"></div>

      <button
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onToggleSpectrogram(); }}
        className={`
            flex items-center gap-2 px-4 py-2 rounded-md border shadow-sm transition-all font-semibold text-sm focus:outline-none
            ${showSpectrogram
                ? 'bg-purple-100 border-purple-300 text-purple-900' 
                : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'}
        `}
        title="Toggle Spectrogram"
      >
        <Waves size={18} />
        <span>Spectrogram</span>
      </button>

      {onFreqRangeChange && (
        <div className="flex items-center gap-1 text-xs text-gray-600" title="Visible range of the logarithmic frequency axis (Hz)">
          <span>Range</span>
          <input
            type="number" min={20} max={20000} step={10}
            className="w-16 border border-gray-300 rounded px-1 py-1 text-right font-mono bg-white"
            value={minDraft}
            onChange={(e) => setMinDraft(e.target.value)}
            onBlur={commitRange}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            title="Lowest frequency shown (Hz)"
          />
          <span>–</span>
          <input
            type="number" min={40} max={20000} step={50}
            className="w-16 border border-gray-300 rounded px-1 py-1 text-right font-mono bg-white"
            value={maxDraft}
            onChange={(e) => setMaxDraft(e.target.value)}
            onBlur={commitRange}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            title="Highest frequency shown (Hz)"
          />
          <span>Hz</span>
          <button
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onFreqRangeChange([50, 5000]); }}
            className="px-1.5 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50"
            title="Reset to 50–5000 Hz"
          >↺</button>
        </div>
      )}
    </div>
  );
};

// Use React.memo to prevent re-renders when parent's currentTime updates
export default React.memo(Mixer);