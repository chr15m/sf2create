# SF2Create

Create SoundFont v2 (.sf2) files from WAV data using JavaScript.

**Note:** this module was largely written by an LLM with some human feedback.

## Install

```bash
npm install sf2create
```

## Usage

Basic usage: `const sf2Blob = createSf2File(dataStructure)`

### Example: Melodic Instrument

```javascript
import { createSf2File } from './create-sf2.mjs';
import fs from 'fs';

// Define your sound data
const soundData = {
  name: 'MySoundFont',
  author: 'My Name', // Optional, defaults to the package name
  samples: [
    {
      name: 'piano',
      rawMonoData: new Float32Array(44100).fill(0.5), // 1 second of sound
      sampleRate: 44100,
      rootNote: 60,
    }
  ],
};

// Create the SoundFont file
const sf2Blob = createSf2File(soundData);

// Write to disk
fs.writeFileSync('output.sf2', Buffer.from(await sf2Blob.arrayBuffer()));
```

### Example: Drum Kit

To create a drum kit, set `isDrumKit: true`. The `rootNote` for each sample specifies the MIDI key it maps to. If `rootNote` is not provided, it will be inferred from the sample `name` based on the General MIDI drum map.

```javascript
import { createSf2File } from './create-sf2.mjs';
import fs from 'fs';

const drumData = {
  name: 'MyDrumKit',
  isDrumKit: true,
  samples: [
    {
      name: 'Kick', // Will default to rootNote 36
      rawMonoData: new Float32Array(22050).fill(0.9),
    },
    {
      name: 'Snare', // Will default to rootNote 38
      rawMonoData: new Float32Array(22050).fill(0.8),
    },
    {
      name: 'Open Hi-Hat', // Defaults to rootNote 46, exclusiveClass 1
      rawMonoData: new Float32Array(44100).fill(0.5),
    },
    {
      name: 'Closed Hi-Hat', // Defaults to rootNote 42, exclusiveClass 1
      rawMonoData: new Float32Array(11025).fill(0.6),
    }
  ]
};

const sf2Blob = createSf2File(drumData);
fs.writeFileSync('drumkit.sf2', Buffer.from(await sf2Blob.arrayBuffer()));
```

## Command-Line Tool

A basic command-line tool `create-sf2-from-wavs.mjs` is included for converting `.wav` files into an SF2 instrument.

For melodic instruments, filenames must contain a note name (e.g., `MySample-A4.wav`).

```bash
node create-sf2-from-wavs.mjs "MyInstrument" samples/*.wav
```

For drum kits, use the `--drums` flag. Note names are not required; the tool will use sample names (e.g., `kick.wav`, `snare.wav`) to look up default MIDI notes.

```bash
node create-sf2-from-wavs.mjs --drums "MyDrumKit" drum-samples/*.wav
```

## Testing

Run the tests:

```bash
npm test
```

## Notes

- Supports 16-bit mono and stereo samples.
- Loop points can be specified for samples.
- Supports basic melodic instruments and GM-compatible drum kits.

## Technical references

- <https://www.synthfont.com/SFSPEC21.PDF>
- <https://github.com/FluidSynth/fluidsynth>
