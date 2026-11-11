
# TonyWeb V0.1

**A web-based visual interface for pitch analysis and note segmentation.**

TonyWeb is a modern browser port of the **Tony** software, designed for the scientific analysis of intonation in solo vocal recordings. It allows users to visualize pitch (f0), correct extraction errors, and segment continuous pitch curves into discrete notes.

**NEW:** Unlike the original Tony software, TonyWeb allows users to **manually correct the pitch of individual notes** by dragging them vertically, with immediate auditory feedback in the musical context.

*Note: Automatic note segmentation is available (see "Automatic Note Segmentation" below) but it is a re-implementation of the idea behind Tony's note tracking, not a port of its code; expect to correct its output manually.*

## Credits & Acknowledgements

This project is a web implementation inspired by the original **Tony** software developed at Queen Mary University of London.

*   **Original Software:** [Tony: Analysis of Song](https://code.soundsoftware.ac.uk/projects/tony)
*   **Original Authors:** Matthias Mauch, Chris Cannam, Rachel Bittner, George Fazekas, and Simon Dixon.
*   **Core Algorithm:** This app implements the **pYIN** algorithm (Probabilistic YIN) for pitch tracking.
    *   *Reference:* Mauch, M., & Dixon, S. (2014). pYIN: A Fundamental Frequency Estimator Using Probabilistic Threshold Distributions. *ICASSP*.
*   **Special Thanks:** To **Chris Cannam** (Centre for Digital Music, QMUL), whose work on Tony and Sonic Visualiser set the standard for audio analysis tools.

---

## User Guide

### 1. Getting Started
*   **Load Audio:** Click `File > Open Audio` (or the folder icon).
    *   *Recommendation:* Use Google Chrome or Edge for the best experience (File System Access API support).
*   **Navigation:**
    *   **Zoom:** Mouse Wheel.
    *   **Scroll:** Drag the "Minimap" at the bottom or hold Shift + Scroll.
    *   **Playback:** Press `Space` to play/pause.

### 2. Pitch Analysis (f0)
The black curve represents the fundamental frequency.
*   **Visuals:** Toggle the Spectrogram, Pitch Curve, and Notes using the "Eye" icons in the Mixer (bottom).
*   **Selection:** Click and drag on the main canvas to select a time region.

### 3. Pitch Correction
If the algorithm makes a mistake (e.g., octave error), you can correct it:
1.  **Select** the region containing the error.
2.  **Show Candidates:** Toggle the "Eye" icon in the "Pitch Correction" toolbar (or press `Shift + C`). You will see yellow dots representing alternative pitch estimates.
3.  **Choose Alternate:**
    *   `Cmd + Arrow Up` / `Ctrl + Arrow Up`: Snap the curve to the next candidate **above**.
    *   `Cmd + Arrow Down` / `Ctrl + Arrow Down`: Snap the curve to the next candidate **below**.
4.  **Recalculate (Deep Search):** If no candidates are visible, click the "Refresh" icon in the toolbar. This re-runs pYIN with a high sensitivity to find faint pitch tracks in the selected region.
5.  **Delete:** Press the Trash icon to mark the region as unvoiced (silence).

**Snap to strongest spectral line (magnet button, Pitch Correction group)** – for ordinary-microphone recordings where the tracker lands on a sub-harmonic. Select a time range, choose the search range (≤ ×1.5 … ×4 of the detected pitch) and click the magnet: every voiced frame in the selection moves to the strongest spectral peak in that range (high-resolution 4096-sample spectrum, parabolic interpolation, a stability bonus for staying near the previous frame). Frames whose current pitch is already (nearly) the strongest line stay unchanged. Undo with Ctrl/Cmd+Z; afterwards re-run Auto-Segment for the corrected range. Caveat: the strongest line can also be a harmonic of the sung pitch, so check the result against the spectrogram. Test: `node tools/snap-test.mjs`.

**Overview bar & frequency axis** – Turn the mouse wheel over the overview (waveform at the bottom) to resize the rectangle (wheel down = larger, up to the whole file; wheel up = smaller). Drag the black handle at the top of the rectangle to scroll the view. The vertical axis is logarithmic (equal distance = equal interval); with *Range* in the mixer bar you can type the lowest and highest visible frequency (e.g. 80 – 800 Hz; ↺ resets). The *Amp* menu in the lower left corner of the overview magnifies the waveform (×1 … ×32 or auto), which makes the onsets of quiet syllables visible. Semitone lines with note names (equal temperament, A4 = 440 Hz) appear as soon as there is enough space; octave lines (A) are labelled in Hz.

### 4. Note Segmentation
The light blue blocks represent discrete notes.

*   **Create/Merge Note:** Select a region and press `=` (Equal Sign). This creates a new note based on the median pitch of the selection. If notes already exist there, it merges/replaces them.
*   **Adjust Boundaries:** Simply hover over the left or right edge of a note (cursor changes to `<->`). Click and drag to resize.
    *   *Smart Resize:* Dragging a boundary will automatically push neighboring notes to prevent overlaps.
    *   *Snap:* Boundaries snap to the nearest audio frame and adjacent notes. Hold `Shift` to disable snapping.
*   **Correct Note Pitch (Innovation):**
    1.  **Double-click** a note body. This selects the note and automatically highlights a "musical context" region (neighboring notes).
    2.  **Drag** the note body up or down to adjust its pitch.
    3.  **Release** the mouse to automatically hear the note played back within its context for auditory verification.
*   **Merge Notes:** Select a time range covering two or more notes and press `-` (or click the Merge icon): they become one note (gaps in between are filled, pitch = median of the pitch track, text = first non-empty text). Without a selection, the selected note (or the note under the cursor) is merged with the next note.
*   **Close Gaps:** Select a time range and click the two-arrows icon (next to Merge): gaps between neighbouring notes inside the selection are closed (both note boundaries move to the middle of the gap). Only gaps up to the length set in the segmentation settings (*Close gaps up to*, default 0.30 s) are closed, so breath pauses stay open.
*   **Split Note:** Place the red playback cursor where you want to cut, then press `/` (Forward Slash) or click the Scissors icon.
*   **Delete Note:** Select a region containing notes and press `Backspace` or `Delete`.

### 4a. Automatic Note Segmentation
Click the **wand icon** in the *Notes* toolbar group to let TonyWeb derive notes from the (corrected) pitch curve.

*   **Whole file:** with no selection, all existing notes are replaced (you are asked to confirm). **Selection:** only the selected region is re-segmented; notes outside stay untouched. Use this after fixing the pitch curve of a passage.
*   Everything is undoable (`Cmd/Ctrl + Z`) and can be edited with the normal note tools afterwards.
*   **Settings** (slider icon next to the wand): *Min. note length* (shorter notes are dropped, default 0.10 s) and *Sensitivity* (higher = more, shorter notes; lower = fewer, longer notes; default 0.85).
*   **How it works:** a Hidden Markov Model with attack / stable / silent states per pitch bin (3 bins per semitone) is decoded with the Viterbi algorithm, modelled on the note-tracking stage of the pYIN plugin used by Tony. Deviations from the original: direct note-to-note transitions without a silent frame (legato), merging of fragments caused by vibrato or single-frame glitches, and a differently scaled observation weight tuned empirically. See `services/noteSegmentation.ts`.
*   **Accuracy (one reference recording):** on a 178 s solo vocal recording, compared with the notes exported from the original Tony, about 91 % of Tony's notes were found (onset within 80 ms, pitch within 0.6 semitones; 90 % of detected notes matched) when using Tony's own pitch track, and about 87 % using TonyWeb's own pitch extraction. Results on other material may differ. You can check your own recordings with `node tools/compare-with-tony.mjs <tony_pitchtrack.txt> <tony_notes.txt>` (needs `npm install` first); `node tools/segmentation-test.mjs` runs a test on synthetic melodies.
*   Memory use grows with recording length (roughly 70 MB per 10 minutes of audio while segmenting).
*   **Second method: stable regions (morphological filter).** In the settings (slider icon) choose *Method → Stable regions*. Instead of the HMM, the pitch track (in cents) is analysed with a sliding maximum/minimum (dilation/erosion); frames in which the pitch hardly moves count as "stable" and become notes, which are then joined, split and trimmed (join: gap ≤ 0.3 s and ≤ 60 ct; split: deviation from the running mean > 30 ct and > 2 standard deviations; trim: ±30 ct). The method follows the Mathematica notebook `PitchtrackSegmentation.nb` and the idea of Rosenzweig, Scherbaum, Müller (ISMIR 2019, stable-region detection), with the notebook's default parameters; deviations are listed in `services/stableRegionSegmentation.ts`. Settings: *Stable fraction* (share of frames regarded as stable, default 0.70) and *Min. note length*. Compared with the HMM it separates repeated notes better but leaves out glides at note boundaries (about 70 % of the voiced time is covered on the test recording), so a **Close gaps** step is provided (see below). Test: `node tools/stable-test.mjs <pitch.csv>` (needs `npm install`).

### 4b. Note Texts (Lyrics) and Headset Recording

Every note can carry a text (e.g. a Georgian syllable). It is shown above the note bar, in the hover info, and saved in the project, CSV (extra `Text` column), SVL (`label`) and in the original Tony format.

**Text entry mode** – press **T** (or the **Aa** button in the Notes group) to switch the mode on, and **T** again to switch it off. In the mode, a click on a note selects it, plays it once (0.12 s context before and after) and shows a text field floating directly above the note, with the cursor already in it. Type the text and press **Return**: the text is stored, the field loses focus, and the mode stays on – click the next note. (While the cursor is inside the field, "t" is an ordinary letter; after Return, T leaves the mode.)

| Key (in the field) | Action |
|---|---|
| Return | store text (also removes an orange review frame) |
| Tab / Shift+Tab | store, go to next / previous note and play it |
| Ctrl/Cmd+Return | replay the note |
| Alt+1 … Alt+4 (or click) | use a suggestion and store it |
| Esc | discard what was typed in the field |

Suggestions are: the final vowel of the previous syllable (continuation notes), the most frequent followers of the previous syllable, and the most frequent syllables so far.

**Second recording (e.g. headset microphone)** – *File → Load Text Audio (Headset)…*. Pitch, segmentation, waveform and spectrogram stay on the main (throat-microphone) recording; in the mixer you can switch the *Audio* channel between **Main** and **Headset**, also during playback. If the recordings do not start at the same moment, correct this with **Offset** (seconds; positive = headset recording is later). The project stores the offset and the file name; the headset file itself has to be loaded again after opening a project.

**Import/Export** – *Export Notes + Text (Tony .txt)* writes `onset<TAB>Hz<TAB>duration<TAB>text`, the same layout as Tony's `Notes.txt`; the notes import reads this layout as well as the CSV layout (delimiter and column order are detected). Re-running auto-segmentation keeps texts of notes that overlap the new notes.

Test: `node tools/text-test.mjs` (requires `npm install`).

### 4c. Automatic Safety Copy

While you work, TonyWeb saves the project (pitch data, notes, texts, view settings – not the audio file) in the browser about two seconds after each change. After a crash or an accidental reload, TonyWeb offers **Restore last session?** at the next start; after *Restore* you are asked to locate the audio file again. Only the most recent project is kept, and it is stored in this browser only: it does not replace saving a `.tonyweb` project file.

### 5. Shortcuts Cheat Sheet

| Action | Shortcut |
| :--- | :--- |
| **Play / Pause** | `Space` |
| **Undo** | `Cmd + Z` / `Ctrl + Z` |
| **Redo** | `Cmd + Shift + Z` / `Ctrl + Y` |
| **Create / Merge Note** | `=` |
| **Split Note** | `/` |
| **Merge Notes** | `-` |
| **Delete Note** | `Backspace` / `Delete` |
| **Show Candidates** | `Shift + C` |
| **Pick Pitch Above** | `Cmd + Up` |
| **Pick Pitch Below** | `Cmd + Down` |
| **Save Project** | `Cmd + S` / `Ctrl + S` |
| **Nudge Cursor** | `Left` / `Right` Arrow |

---

## Browser Compatibility

**Google Chrome / Microsoft Edge (Recommended)**
*   Supports **Overwriting** files (File System Access API).
*   Supports native **Pitch Preservation** when slowing down playback speed.

**Firefox / Safari**
*   **Saving:** Due to browser security restrictions, the app cannot open a native "Save As" dialog or overwrite files. It will open a custom popup asking for a filename and then trigger a standard download.
*   **Playback Speed:** Pitch preservation (time-stretching) relies on the browser's implementation. In some versions, slowing down audio may drop the pitch (like a vinyl record).

---

## Development

This project uses React, TypeScript, and Tailwind CSS.
Analysis (pYIN/FFT) is offloaded to Web Workers for performance.

**Install Dependencies:**
```bash
npm install
```

**Run Locally:**
```bash
npm run dev
```

## License

The additions in this fork (automatic note segmentation, note texts, headset audio, tools) are released under the **GNU General Public License v3.0 or later** (see `LICENSE`). The note-segmentation approach follows the algorithms of Tony / pYIN (Queen Mary University of London, GPL v2 or later). Code inherited from the original TonyWeb repository keeps its original authors' rights; that repository did not state a license at the time of forking.
