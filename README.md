# SF2Create

Create SoundFont v2 (.sf2) files from WAV data using JavaScript.

**Note:** this module was largely written by an LLM with some human feedback.

## Install

```bash
npm install sf2create
```

## Usage

Basic usage: `const sf2Blob = createSf2File(dataStructure)`

### Example

```javascript
import { createSf2File } from './create-sf2.mjs';
import fs from 'fs';

// Define your sound data
const soundData = {
  name: 'MySoundFont',
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

## Testing

Run the tests:

```bash
npm test
```

## Notes

- Supports 16-bit mono and stereo samples.
- Loop points can be specified for samples.

## Technical references

- <https://www.synthfont.com/SFSPEC21.PDF>
- <https://github.com/FluidSynth/fluidsynth>
