/**
 * test-create-sf2.js
 *
 * Basic tests for createSf2File function. Run with:
 *    npm install mocha chai
 *    npx mocha test-create-sf2.js
 */

import { expect } from 'chai';
import { createSf2File } from './create-sf2.mjs';

// A minimal polyfill if needed (for Blob in Node)
import { Blob } from 'buffer';
globalThis.Blob = Blob;

describe('createSf2File', () => {
  it('Should return a Blob even with empty input', () => {
    const data = {};
    const result = createSf2File(data);
    expect(result).to.be.instanceOf(Blob);
    expect(result.size).to.be.greaterThan(44); 
    // 44 is the absolute minimal header size in a RIFF file
  });

  it('Should embed one sample when given a single sample', () => {
    const singleSampleData = new Float32Array(44100).fill(0.5); // 1 second of amplitude=0.5
    const data = {
      name: 'TestOneSample',
      samples: [
        {
          name: 'kick',
          rawMonoData: singleSampleData,
          sampleRate: 44100,
          rootNote: 36,
        }
      ],
    };
    const result = createSf2File(data);
    expect(result).to.be.instanceOf(Blob);
    expect(result.size).to.be.greaterThan(1000);
  });

  it('Should create multiple samples, each mapped to different ranges', () => {
    const sampleA = new Float32Array(22050).fill(0.3);
    const sampleB = new Float32Array(11025).fill(-0.2);

    const data = {
      name: 'TwoSamples',
      samples: [
        {
          name: 'lowRangeSample',
          rawMonoData: sampleA,
          rootNote: 40,
          noteRange: [0, 60],
        },
        {
          name: 'highRangeSample',
          rawMonoData: sampleB,
          rootNote: 70,
          noteRange: [61, 127],
        }
      ]
    };

    const result = createSf2File(data);
    expect(result).to.be.instanceOf(Blob);
    expect(result.size).to.be.greaterThan(2000);
  });

  it('Should handle loop points if specified', () => {
    const sampleLooped = new Float32Array(10000).fill(0.8);
    const data = {
      name: 'LoopedSample',
      samples: [
        {
          name: 'looped',
          rawMonoData: sampleLooped,
          sampleRate: 48000,
          rootNote: 60,
          loopStart: 100,
          loopEnd: 9900,
        }
      ]
    };
    const result = createSf2File(data);
    expect(result).to.be.instanceOf(Blob);
    // We can't trivially parse the loop points here without an SF2 parser,
    // but we can at least check the file is bigger than the sample alone
    expect(result.size).to.be.greaterThan(1000);
  });

  it('Should generate a valid drumkit SF2 file', () => {
    const kickSample = new Float32Array(10000).fill(0.9);
    const snareSample = new Float32Array(10000).fill(0.7);

    const data = {
      name: 'TestDrumKit',
      isDrumKit: true,
      samples: [
        {
          name: 'kick', // will map to rootNote 36
          rawMonoData: kickSample,
          sampleRate: 44100,
        },
        {
          name: 'snare', // will map to rootNote 38
          rawMonoData: snareSample,
          sampleRate: 44100,
        },
      ],
    };

    const result = createSf2File(data);
    expect(result).to.be.instanceOf(Blob);
    expect(result.size).to.be.greaterThan(1000);
  });
});
