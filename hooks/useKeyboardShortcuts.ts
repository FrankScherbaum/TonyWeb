
import { useEffect } from 'react';

interface KeyboardShortcutsProps {
  onPlayPause: () => void;
  onDeleteNotes: () => void;
  onCreateNote: () => void;
  onSplitNote: () => void;
  onMergeNotes?: () => void;
  onToggleCandidates: () => void;
  onSaveProject: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onPitchCorrection: (dir: 'up' | 'down') => void;
  onSeek: (time: number) => void;
  currentTime: number;
}

export const useKeyboardShortcuts = ({
  onPlayPause,
  onDeleteNotes,
  onCreateNote,
  onSplitNote,
  onMergeNotes,
  onToggleCandidates,
  onSaveProject,
  onUndo,
  onRedo,
  onPitchCorrection,
  onSeek,
  currentTime
}: KeyboardShortcutsProps) => {

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        // Ignore if user is typing in a text input (e.g. Save Modal)
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        
        // Playback
        if (e.code === 'Space') { 
            e.preventDefault(); 
            onPlayPause(); 
            return; 
        }

        // Notes
        if (e.code === 'Backspace' || e.code === 'Delete') { 
            e.preventDefault(); 
            onDeleteNotes(); 
            return; 
        }
        if (e.key === '=') { 
            e.preventDefault(); 
            onCreateNote(); 
            return; 
        }
        if (e.key === '/') { 
            e.preventDefault(); 
            onSplitNote(); 
            return; 
        }
        if (e.key === '-' && !e.metaKey && !e.ctrlKey && onMergeNotes) { 
            e.preventDefault(); 
            onMergeNotes(); 
            return; 
        }

        // Correction Tools
        if (e.shiftKey && e.code === 'KeyC') { 
            e.preventDefault(); 
            onToggleCandidates(); 
            return; 
        }
        if ((e.metaKey || e.ctrlKey)) {
             if (e.code === 'ArrowUp') { 
                 e.preventDefault(); 
                 onPitchCorrection('up'); 
             }
             if (e.code === 'ArrowDown') { 
                 e.preventDefault(); 
                 onPitchCorrection('down'); 
             }
        }

        // File Operations
        if ((e.metaKey || e.ctrlKey) && e.code === 'KeyS') { 
            e.preventDefault(); 
            onSaveProject(); 
            return; 
        }

        // Undo / Redo
        if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') { 
            e.preventDefault(); 
            e.shiftKey ? onRedo() : onUndo(); 
            return; 
        }
        if ((e.metaKey || e.ctrlKey) && e.code === 'KeyY') { 
            e.preventDefault(); 
            onRedo(); 
            return; 
        }
        
        // Navigation
        if (e.code === 'ArrowLeft') { 
            e.preventDefault(); 
            onSeek(currentTime - 0.1); 
        }
        if (e.code === 'ArrowRight') { 
            e.preventDefault(); 
            onSeek(currentTime + 0.1); 
        }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    onPlayPause, 
    onDeleteNotes, 
    onCreateNote, 
    onSplitNote, 
    onMergeNotes, 
    onToggleCandidates, 
    onSaveProject, 
    onUndo, 
    onRedo, 
    onPitchCorrection, 
    onSeek, 
    currentTime
  ]);
};
