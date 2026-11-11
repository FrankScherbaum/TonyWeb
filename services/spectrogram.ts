
import { SpectrogramData } from '../types';

export const generateSpectrogram = async (
  audioBuffer: AudioBuffer
): Promise<SpectrogramData> => {
  const channelData = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;

  const workerCode = `
    self.onmessage = function(e) {
      const { channelData, sampleRate } = e.data;
      const result = computeSpectrogram(channelData, sampleRate);
      self.postMessage(result);
    };

    function computeSpectrogram(data, sampleRate) {
      const fftSize = 2048;
      const hopSize = 512; // 11.6ms overlap
      const windowSize = fftSize;
      
      const numFrames = Math.floor((data.length - windowSize) / hopSize);
      const bins = fftSize / 2;
      
      // We will return a flat array for transfer efficiency, or array of arrays
      // Let's use array of arrays to match the type expected by UI
      // Note: Transferring massive arrays can be slow.
      // Optimization: We only need magnitudes.
      
      const magnitudes = [];
      let maxMag = 0;

      // Precompute Window (Hann)
      const win = new Float32Array(windowSize);
      for(let i=0; i<windowSize; i++) {
        win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (windowSize - 1)));
      }

      // Reusable buffers
      const real = new Float32Array(fftSize);
      const imag = new Float32Array(fftSize);

      for (let i = 0; i < numFrames; i++) {
        const start = i * hopSize;
        
        // Windowing
        for (let j = 0; j < windowSize; j++) {
            if (start + j < data.length) {
                real[j] = data[start + j] * win[j];
            } else {
                real[j] = 0;
            }
            imag[j] = 0;
        }

        // FFT
        simpleFFT(real, imag);

        // Magnitude
        const magFrame = new Float32Array(bins);
        for (let j = 0; j < bins; j++) {
            const mag = Math.sqrt(real[j] * real[j] + imag[j] * imag[j]);
            magFrame[j] = mag;
            if (mag > maxMag) maxMag = mag;
        }
        magnitudes.push(magFrame);
      }

      return {
        width: numFrames,
        height: bins,
        magnitude2d: magnitudes,
        maxMagnitude: maxMag,
        sampleRate: sampleRate
      };
    }

    // Simple Radix-2 FFT (Cooley-Tukey)
    // Note: data length must be power of 2 (2048 is)
    function simpleFFT(re, im) {
      const n = re.length;
      if (n <= 1) return;

      const half = n / 2;
      
      // Bit reversal permutation
      let i2 = half;
      for (let i = 1; i < n - 1; i++) {
          if (i < i2) {
              let temp = re[i]; re[i] = re[i2]; re[i2] = temp;
              temp = im[i]; im[i] = im[i2]; im[i2] = temp;
          }
          let k = half;
          while (k <= i2) {
              i2 -= k;
              k /= 2;
          }
          i2 += k;
      }

      // Butterfly
      for (let len = 2; len <= n; len <<= 1) {
          const halfLen = len >> 1;
          const angle = -2 * Math.PI / len;
          const wRe = Math.cos(angle);
          const wIm = Math.sin(angle);
          
          for (let i = 0; i < n; i += len) {
              let uRe = 1;
              let uIm = 0;
              for (let j = 0; j < halfLen; j++) {
                  const evenIndex = i + j;
                  const oddIndex = i + j + halfLen;
                  
                  const tRe = uRe * re[oddIndex] - uIm * im[oddIndex];
                  const tIm = uRe * im[oddIndex] + uIm * re[oddIndex];
                  
                  re[oddIndex] = re[evenIndex] - tRe;
                  im[oddIndex] = im[evenIndex] - tIm;
                  re[evenIndex] += tRe;
                  im[evenIndex] += tIm;
                  
                  const tempRe = uRe * wRe - uIm * wIm;
                  uIm = uRe * wIm + uIm * wRe;
                  uRe = tempRe;
              }
          }
      }
    }
  `;

  const blob = new Blob([workerCode], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(blob);
  const worker = new Worker(workerUrl);

  return new Promise((resolve) => {
    worker.onmessage = (e) => {
      resolve(e.data);
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    };
    worker.postMessage({ channelData, sampleRate });
  });
};
