

import { PitchFrame } from '../types';

export const YIN_HOP_SIZE = 512; // Standard hop size for pYIN (samples)
export const YIN_WINDOW_SIZE = 2048; // Standard analysis window (samples)

export interface PyinParams {
  threshold?: number;
  rmsThreshold?: number;
  /** Time step between analysis frames in samples (default 512 = 11.6 ms at 44.1 kHz) */
  hopSize?: number;
  /** Analysis window in samples (default 2048). Smaller = better time resolution, but the lowest detectable f0 rises (sampleRate / (window/2)). */
  windowSize?: number;
}

/**
 * Starts the pYIN analysis in a separate Web Worker thread.
 * Now accepts Float32Array directly for partial updates.
 */
export const extractPitch = async (
  audioData: Float32Array,
  sampleRate: number,
  onProgress: (progress: number) => void,
  params: PyinParams = {} // Optional overrides
): Promise<PitchFrame[]> => {
  
  const workerCode = `
    const pYIN = ${pYinWorkerCode.toString()};
    pYIN();
  `;
  
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(blob);
  const worker = new Worker(workerUrl);

  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === 'progress') {
        onProgress(payload);
      } else if (type === 'result') {
        resolve(payload);
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
      } else if (type === 'error') {
        reject(payload);
        worker.terminate();
      }
    };

    // Send audio data and params to worker
    worker.postMessage({
      data: audioData,
      sampleRate: sampleRate,
      params: params
    });
  });
};

/**
 * THE WORKER CODE
 * Contains all logic and helper functions nested inside to ensure
 * they are serialized correctly when toString() is called.
 */
function pYinWorkerCode() {
  /* eslint-disable no-restricted-globals */
  self.onmessage = function(e: any) {
    const { data, sampleRate, params } = e.data;
    try {
        const result = runPyin(data, sampleRate, params || {});
        self.postMessage({ type: 'result', payload: result });
    } catch (err) {
        self.postMessage({ type: 'error', payload: err });
    }
  };

  interface Candidate {
    frequency: number;
    probability: number;
    yinDip: number;
  }

  function runPyin(data: Float32Array, sampleRate: number, params: any) {
    // pYIN Configuration
    const bufferSize = params.windowSize !== undefined ? Math.max(256, Math.round(params.windowSize)) : 2048;
    const step = Math.max(32, Math.min(bufferSize, Math.round(params.hopSize !== undefined ? params.hopSize : 512)));
    // The Viterbi costs below were tuned for hop 512; with a finer time step there are more
    // frames per second, so the transition costs are scaled up to keep the balance.
    const hopScale = 512 / step;
    const minFreq = 60;   
    const maxFreq = 1200; 
    
    // Use params if provided, else defaults
    const threshold = params.threshold !== undefined ? params.threshold : 0.75; 
    const rmsThreshold = params.rmsThreshold !== undefined ? params.rmsThreshold : 0.01;
    
    // Is this a Deep Search? (High threshold implies user wants to see everything)
    const isDeepSearch = threshold > 0.8;

    // Viterbi Costs
    const transitionCostWeight = 1.0 * hopScale; 
    const voicingTransitionCost = 1.5 * hopScale;
    
    const totalSamples = data.length;
    
    // 1. Candidate Extraction Phase
    const numFrames = Math.floor((totalSamples - bufferSize) / step);
    
    const minPeriod = Math.floor(sampleRate / maxFreq);
    const maxPeriod = Math.min(Math.floor(sampleRate / minFreq), Math.floor(bufferSize / 2) - 2);

    const allCandidates: Candidate[][] = [];

    for (let i = 0; i < numFrames; i++) {
      if (i % 50 === 0) {
        self.postMessage({ type: 'progress', payload: (i / numFrames) * 0.5 });
      }

      const start = i * step;
      const chunk = data.slice(start, start + bufferSize);
      
      let sumSq = 0;
      for (let s = 0; s < chunk.length; s++) sumSq += chunk[s] * chunk[s];
      const rms = Math.sqrt(sumSq / chunk.length);

      const frameCandidates: Candidate[] = [];
      
      if (rms < rmsThreshold) {
          frameCandidates.push({
              frequency: 0,
              probability: 0.99,
              yinDip: 0.01
          });
          allCandidates.push(frameCandidates);
          continue;
      }

      const yinBuffer = computeYinBuffer(chunk, bufferSize);
      
      // If Deep Search, ignore threshold check (effectively threshold = Infinity)
      // We want ALL local minima.
      const effectiveThreshold = isDeepSearch ? 10.0 : threshold;

      for (let tau = minPeriod; tau < Math.min(maxPeriod, yinBuffer.length - 1); tau++) {
        // Check against threshold (or pass if deep search)
        if (yinBuffer[tau] < effectiveThreshold) {
          // Local Minimum check
          if (yinBuffer[tau] < yinBuffer[tau - 1] && yinBuffer[tau] < yinBuffer[tau + 1]) {
            const betterTau = parabolicInterpolation(yinBuffer, tau);
            const freq = sampleRate / betterTau;
            
            // For deep search, we might get dips close to 1.0. 
            // Probability shouldn't be negative.
            let prob = 1 - yinBuffer[tau];
            if (prob < 0.0001) prob = 0.0001;

            frameCandidates.push({
              frequency: freq,
              probability: prob,
              yinDip: yinBuffer[tau]
            });
          }
        }
      }

      // Limit candidates per frame during Deep Search to prevent performance bomb
      // Sort by YinDip (lower is better) and take top 20
      if (isDeepSearch && frameCandidates.length > 20) {
          frameCandidates.sort((a, b) => a.yinDip - b.yinDip);
          frameCandidates.splice(20);
      }

      let bestDip = 1.0;
      frameCandidates.forEach(c => { if(c.yinDip < bestDip) bestDip = c.yinDip; });

      let unvoicedProb = Math.min(0.9, Math.max(0.05, bestDip * 0.5));
      
      if (isDeepSearch) {
          // CRITICAL: Force the algorithm to pick ANY pitch over silence during deep search.
          // Setting this to effectively zero ensures Voiced path is always cheaper.
          unvoicedProb = 1e-15; 
      }

      frameCandidates.push({
        frequency: 0,
        probability: unvoicedProb, 
        yinDip: 1.0 - unvoicedProb 
      });

      allCandidates.push(frameCandidates);
    }

    // 2. Viterbi Decoding Phase
    self.postMessage({ type: 'progress', payload: 0.6 });

    const T = allCandidates.length;
    if (T === 0) return [];

    const cost: number[][] = new Array(T).fill(0).map(() => []);
    const path: number[][] = new Array(T).fill(0).map(() => []);

    for (let k = 0; k < allCandidates[0].length; k++) {
      cost[0][k] = 1 - allCandidates[0][k].probability; 
    }

    for (let t = 1; t < T; t++) {
      if (t % 100 === 0) {
         self.postMessage({ type: 'progress', payload: 0.5 + (t / T) * 0.4 });
      }

      const prevCandidates = allCandidates[t - 1];
      const currCandidates = allCandidates[t];

      for (let k = 0; k < currCandidates.length; k++) {
        let minCost = Infinity;
        let bestPrevIdx = 0;

        const curr = currCandidates[k];

        for (let j = 0; j < prevCandidates.length; j++) {
          const prev = prevCandidates[j];
          let transCost = 0;

          if (prev.frequency > 0 && curr.frequency > 0) {
            const octDiff = Math.abs(Math.log2(curr.frequency / prev.frequency));
            transCost = octDiff * transitionCostWeight;
          } else if (prev.frequency !== curr.frequency) {
            transCost = voicingTransitionCost; 
          } else {
            transCost = 0;
          }

          const emissionCost = (1 - curr.probability);
          const totalPathCost = cost[t - 1][j] + transCost + emissionCost;

          if (totalPathCost < minCost) {
            minCost = totalPathCost;
            bestPrevIdx = j;
          }
        }

        cost[t][k] = minCost;
        path[t][k] = bestPrevIdx;
      }
    }

    // Backtracking
    const rawResults = [];
    let bestIdx = 0;
    let minFinalCost = Infinity;
    const lastFrameIndices = allCandidates[T - 1];
    
    for (let k = 0; k < lastFrameIndices.length; k++) {
      if (cost[T - 1][k] < minFinalCost) {
        minFinalCost = cost[T - 1][k];
        bestIdx = k;
      }
    }

    for (let t = T - 1; t >= 0; t--) {
      const candidate = allCandidates[t][bestIdx];
      const time = t * step / sampleRate;

      // Filter candidates for UI
      // Return all pitched candidates found
      const uiCandidates = allCandidates[t]
        .filter(c => c.frequency > 0)
        .map(c => ({
            frequency: c.frequency,
            probability: c.probability
        }));

      rawResults[t] = {
        timestamp: time,
        frequency: candidate.frequency,
        probability: candidate.probability,
        hasPitch: candidate.frequency > 0,
        candidates: uiCandidates
      };

      bestIdx = path[t][bestIdx];
    }

    self.postMessage({ type: 'progress', payload: 0.95 });

    // 3. Post-Processing
    // When performing deep search (high threshold), we want to disable despeckling
    // to ensure tiny candidates are seen.
    const runDespeckling = !isDeepSearch; 

    const cleanedResults = [...rawResults];

    if (runDespeckling) {
        const minDurationFrames = Math.max(1, Math.round(8 * hopScale)); // 8 frames at hop 512
        let runStart = -1;

        for(let i = 0; i < cleanedResults.length; i++) {
            const isVoiced = cleanedResults[i].hasPitch;
            if (isVoiced) {
                if (runStart === -1) runStart = i;
            } else {
                if (runStart !== -1) {
                    const runLength = i - runStart;
                    if (runLength < minDurationFrames) {
                        for(let j = runStart; j < i; j++) {
                            cleanedResults[j].frequency = 0;
                            cleanedResults[j].hasPitch = false;
                        }
                    }
                    runStart = -1;
                }
            }
        }
        if (runStart !== -1) {
            const runLength = cleanedResults.length - runStart;
            if (runLength < minDurationFrames) {
                for(let j = runStart; j < cleanedResults.length; j++) {
                    cleanedResults[j].frequency = 0;
                    cleanedResults[j].hasPitch = false;
                }
            }
        }
    }

    return cleanedResults;
  }

  function computeYinBuffer(buffer: Float32Array, bufferSize: number): Float32Array {
    const halfBufferSize = Math.floor(bufferSize / 2);
    const yinBuffer = new Float32Array(halfBufferSize);

    for (let tau = 0; tau < halfBufferSize; tau++) {
      yinBuffer[tau] = 0;
      for (let j = 0; j < halfBufferSize; j++) {
        const diff = buffer[j] - buffer[j + tau];
        yinBuffer[tau] += diff * diff;
      }
    }

    yinBuffer[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau < halfBufferSize; tau++) {
      runningSum += yinBuffer[tau];
      if (runningSum === 0) {
        yinBuffer[tau] = 1;
      } else {
        yinBuffer[tau] *= tau / runningSum;
      }
    }

    return yinBuffer;
  }

  function parabolicInterpolation(yinBuffer: Float32Array, tau: number): number {
    const x0 = tau;
    const x1 = tau < yinBuffer.length - 1 ? tau + 1 : tau;
    const x2 = tau > 0 ? tau - 1 : tau;
    if (x0 === x1) return x0;
    if (x0 === x2) return x0;
    const s0 = yinBuffer[x0];
    const s1 = yinBuffer[x1];
    const s2 = yinBuffer[x2];
    const denominator = 2 * s0 - s2 - s1;
    if (denominator === 0) return x0;
    const adjustment = (s2 - s1) / (2 * denominator);
    return x0 + adjustment;
  }
}
