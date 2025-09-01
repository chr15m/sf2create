#!/usr/bin/env node

import fs from 'fs';
import { readFile } from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import wav from 'node-wav';

// Be sure create-sf2.mjs is in the same folder or adjust as needed.
// This should be the stereo-capable version you wrote previously.
import { createSf2File } from './create-sf2.mjs';

////////////////////////////////////////////////////////////////////////////////
// 1) Utility: Convert note names like "A3", "G#4" into MIDI note numbers
////////////////////////////////////////////////////////////////////////////////

const NOTE_OFFSETS = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11
};

function noteNameToMidi(noteName) {
  const match = /^([A-G])([#b]?)(-?\d+)$/.exec(noteName.trim());
  if (!match) {
    throw new Error(`Invalid note name: ${noteName}`);
  }
  const [, letter, accidental, octaveStr] = match;
  let offset = NOTE_OFFSETS[letter] ?? 0;
  if (accidental === '#') offset += 1;
  if (accidental === 'b') offset -= 1;

  const octave = parseInt(octaveStr, 10);
  return 12 * (octave + 1) + offset;
}

function extractNoteName(filename) {
  // E.g. "Banjo_Common - A3.wav" => "A3"
  //      "Banjo_Common - G#4.wav" => "G#4"
  const notePattern = /([A-G][#b]?-?\d+)/;
  const match = notePattern.exec(filename);
  return match ? match[1] : null;
}

////////////////////////////////////////////////////////////////////////////////
// 2) Read WAV data, detect mono/stereo
////////////////////////////////////////////////////////////////////////////////

/**
 * readWavFile(filePath) -> {
 *   channels: 1 or 2,
 *   sampleRate: number,
 *   data: Float32Array (for mono => rawMonoData, for stereo => rawStereoData)
 * }
 */
async function readWavFile(filePath) {
  const buffer = await readFile(filePath);
  const result = wav.decode(buffer); 
  const { sampleRate, channelData } = result;

  if (channelData.length === 1) {
    // ----- MONO -----
    return {
      channels: 1,
      sampleRate,
      data: channelData[0]
    };
  } else if (channelData.length === 2) {
    // ----- STEREO -----
    const left  = channelData[0];
    const right = channelData[1];
    const numFrames = Math.min(left.length, right.length);
    // Interleave [L0, R0, L1, R1, ...]
    const interleaved = new Float32Array(numFrames * 2);
    for (let i = 0; i < numFrames; i++) {
      interleaved[2*i]   = left[i];
      interleaved[2*i+1] = right[i];
    }
    return {
      channels: 2,
      sampleRate,
      data: interleaved
    };
  } else {
    // More than 2 channels not supported in this minimal example
    throw new Error(`Unsupported channel count: ${channelData.length}`);
  }
}

////////////////////////////////////////////////////////////////////////////////
// 3) Main logic: gather arguments, read WAVs, build SF2, save .sf2
////////////////////////////////////////////////////////////////////////////////

async function main() {
  const originalArgs = process.argv.slice(2);
  const isDrumKit = originalArgs.includes('--drums');
  const args = originalArgs.filter(arg => arg !== '--drums');

  if (args.length < 2) {
    console.error('Usage: node create-sf2-from-wavs.mjs [--drums] "<InstrumentName>" wav-files...');
    process.exit(1);
  }

  const instrumentName = args[0];
  const wavPaths = args.slice(1);

  const samples = [];

  for (const wavPath of wavPaths) {
    const basename = path.basename(wavPath);
    const sampleName = basename.replace('.wav', '');

    let wavInfo;
    try {
      wavInfo = await readWavFile(wavPath);
    } catch (err) {
      console.error(`Error reading WAV "${wavPath}":`, err);
      continue;
    }
    const { channels, sampleRate, data } = wavInfo;

    const sampleObj = {
      name: sampleName,
      sampleRate,
      channels,
    };

    if (isDrumKit) {
      console.log(`Reading "${basename}" -> drum sample: ${sampleName}`);
    } else {
      const noteStr = extractNoteName(basename);
      if (!noteStr) {
        console.warn(`Skipping "${basename}": no note name found in filename.`);
        continue;
      }

      let midiNote;
      try {
        midiNote = noteNameToMidi(noteStr);
      } catch (err) {
        console.warn(`Skipping "${basename}": ${err.message}`);
        continue;
      }
      sampleObj.rootNote = midiNote;
      sampleObj.noteRange = [0, 127]; // cover full range unless you want narrower
      console.log(`Reading "${basename}" -> note: ${noteStr}, MIDI: ${midiNote}`);
    }

    if (channels === 1) {
      sampleObj.rawMonoData = data;
    } else {
      sampleObj.rawStereoData = data;
    }

    samples.push(sampleObj);
  }

  if (samples.length === 0) {
    console.error('No valid samples found. Exiting.');
    process.exit(1);
  }

  const sf2Data = {
    name: instrumentName,
    samples,
    isDrumKit,
  };

  console.log('Creating SF2 file...');
  const sf2Blob = createSf2File(sf2Data);

  const arrayBuffer = await sf2Blob.arrayBuffer();
  const outPath = `${instrumentName}.sf2`;
  fs.writeFileSync(outPath, new Uint8Array(arrayBuffer));
  console.log(`SF2 file written to: ${outPath}`);
}

// ---------------------------------------------------------------------------
// If invoked directly (instead of imported), run main():
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
