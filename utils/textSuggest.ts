import { Note } from '../types';

const GEORGIAN_VOWELS = 'აეიოუ';

/**
 * Suggestions for the text of a note, based on the previous note and on what
 * has already been typed in this project:
 *  1. the final vowel of the previous syllable (continuation notes: "ა" after "და")
 *  2. the most frequent followers of the previous syllable (bigram)
 *  3. the most frequent syllables overall
 * Returns up to `max` distinct suggestions.
 */
export const suggestNoteTexts = (sortedNotes: Note[], index: number, max = 4): string[] => {
    const out: string[] = [];
    const add = (t: string | undefined) => {
        if (t && !out.includes(t) && out.length < max) out.push(t);
    };

    const prev = index > 0 ? (sortedNotes[index - 1].text || '') : '';

    if (prev) {
        const last = prev[prev.length - 1];
        if (GEORGIAN_VOWELS.includes(last)) add(last);
    }

    // follower counts (only among notes that already have text)
    const follow = new Map<string, number>();
    const freq = new Map<string, number>();
    for (let i = 0; i < sortedNotes.length; i++) {
        if (i === index) continue;
        const t = sortedNotes[i].text;
        if (!t) continue;
        freq.set(t, (freq.get(t) || 0) + 1);
        const p = i > 0 ? sortedNotes[i - 1].text : '';
        if (prev && p === prev) follow.set(t, (follow.get(t) || 0) + 1);
    }
    const top = (m: Map<string, number>) =>
        [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(e => e[0]);

    top(follow).slice(0, 3).forEach(add);
    top(freq).forEach(add);
    return out;
};
