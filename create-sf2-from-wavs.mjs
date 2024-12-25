#!/usr/bin/env node

import fs from 'fs';
import { readFile } from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import wav from 'node-wav';

// Be sure create-sf2.mjs is in the same folder or adjust the path as needed
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
  // E.g. "Banjo_Common - A3.wav" -> "A3"
  //      "Banjo_Common - G#4.wav" -> "G#4"
  const notePattern = /([A-G][#b]?-?\d+)/;
  const match = notePattern.exec(filename);
  return match ? match[1] : null;
}

////////////////////////////////////////////////////////////////////////////////
// 2) Read WAV data as Float32 arrays
////////////////////////////////////////////////////////////////////////////////

async function readWavAsFloat32(filePath) {
  const buffer = await readFile(filePath);
  const result = wav.decode(buffer);
  // result.channelData is an array of Float32Arrays (one per channel)
  return result.channelData[0]; // pick the first channel for simplicity
}

////////////////////////////////////////////////////////////////////////////////
// 3) Main logic: gather arguments, read WAVs, build SF2, save .sf2
////////////////////////////////////////////////////////////////////////////////

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node create-sf2-from-wavs.mjs "<InstrumentName>" wav-files...');
    process.exit(1);
  }

  const instrumentName = args[0];
  const wavPaths = args.slice(1);

  const samples = [];

  for (const wavPath of wavPaths) {
    const basename = path.basename(wavPath);
    const noteStr = extractNoteName(basename);
    if (!noteStr) {
      console.warn(`Skipping "${basename}": no note name found.`);
      continue;
    }

    let midiNote;
    try {
      midiNote = noteNameToMidi(noteStr);
    } catch (err) {
      console.warn(`Skipping "${basename}": ${err.message}`);
      continue;
    }

    console.log(`Reading "${basename}" -> note: ${noteStr}, MIDI: ${midiNote}`);

    let wavData;
    try {
      wavData = await readWavAsFloat32(wavPath);
    } catch (err) {
      console.error(`Error reading WAV "${wavPath}":`, err);
      continue;
    }

    samples.push({
      name: basename.replace('.wav', ''),
      rawMonoData: wavData,
      sampleRate: 44100,
      rootNote: midiNote,
      noteRange: [0, 127]
    });
  }

  if (samples.length === 0) {
    console.error('No valid samples found. Exiting.');
    process.exit(1);
  }

  const sf2Data = {
    name: instrumentName,
    author: 'AutoGenerated',
    samples
  };

  console.log('Creating SF2 file...');
  const sf2Blob = createSf2File(sf2Data);

  const arrayBuffer = await sf2Blob.arrayBuffer();
  const outPath = `${instrumentName}.sf2`;
  fs.writeFileSync(outPath, new Uint8Array(arrayBuffer));
  console.log(`SF2 file written to: ${outPath}`);
}

// ---------------------------------------------------------------------------
// If you only run this script via `node create-sf2-from-wavs.mjs`, you can
// either remove this check, or do a proper fileURL comparison:
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The script is being executed directly
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}