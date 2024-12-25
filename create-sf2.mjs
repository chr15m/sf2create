/**
 * create-sf2.mjs
 *
 * A minimal, high-level library to build SF2 (SoundFont v2) files
 * in JavaScript, returning them as a Blob. This version:
 *   - If valid loop points are provided (loopStart < loopEnd), sets sampleModes=1 (loop).
 *   - Otherwise, sets sampleModes=0 (no loop) and chooses loop points at the end of the sample
 *     (i.e., loopStart = numFrames - 1, loopEnd = numFrames).
 *   - **Fix**: Convert local loopStart/loopEnd to absolute offsets in the smpl chunk for shdr.
 */

//
// 0. Helpful utilities
//

/**
 * Convert from Float32 samples [-1.0, 1.0] to 16-bit signed PCM.
 * @param {Float32Array} floatArray
 * @returns {Int16Array}
 */
function float32ToInt16(floatArray) {
  const int16 = new Int16Array(floatArray.length);
  for (let i = 0; i < floatArray.length; i++) {
    let s = floatArray[i];
    // Clamp to [-1, 1]
    if (s > 1.0) s = 1.0;
    else if (s < -1.0) s = -1.0;
    // Convert float -> int16
    int16[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return int16;
}

/**
 * Write a string into a DataView, ASCII-encoded, with trailing zeros up to length.
 * @param {DataView} view
 * @param {number} offset
 * @param {string} str
 * @param {number} length
 */
function writeFixedAsciiString(view, offset, str, length) {
  const encoder = new TextEncoder(); // default UTF-8
  const bytes = encoder.encode(str.slice(0, length)); // trim to max length
  let i = 0;
  for (; i < bytes.length && i < length; i++) {
    view.setUint8(offset + i, bytes[i]);
  }
  for (; i < length; i++) {
    view.setUint8(offset + i, 0);
  }
}

/**
 * Prepare the samples data structure:
 *   - Convert rawMonoData => pcm16
 *   - Determine if loop points are valid
 *   - Assign loopStart, loopEnd, and sampleMode (0=no loop, 1=continuous loop)
 */
function prepareSamples(data) {
  const allSamples = [];

  if (!data.samples || data.samples.length === 0) {
    // If no samples given, create a trivial silent sample
    allSamples.push({
      name: 'Empty',
      pcm16: new Int16Array([0, 0, 0, 0]),
      sampleRate: 44100,
      rootNote: 60,
      loopStart: 0,
      loopEnd: 1, // minimal region at the end
      sampleMode: 0, // no loop
      noteRange: [0, 127],
      channels: 1
    });
    return allSamples;
  }

  let idx = 0;
  for (const s of data.samples) {
    const rawMonoData = s.rawMonoData || new Float32Array([0]);
    const pcm16 = float32ToInt16(rawMonoData);
    const numFrames = pcm16.length;
    const name = s.name || `sample_${idx}`;
    const sr = s.sampleRate || 44100;
    const root = (s.rootNote === undefined) ? 60 : s.rootNote;

    // Default: no loop, we set the loop region to [numFrames-1..numFrames]
    let sampleMode = 0; // 0 => no loop
    let loopStartVal = numFrames - 1;
    let loopEndVal = numFrames;

    // If user gave valid loop points, enable continuous looping
    if (
      typeof s.loopStart === 'number' && 
      typeof s.loopEnd === 'number' &&
      s.loopEnd > s.loopStart && 
      s.loopStart >= 0 && 
      s.loopEnd <= numFrames
    ) {
      sampleMode = 1; 
      loopStartVal = s.loopStart;
      loopEndVal   = s.loopEnd;
    }

    allSamples.push({
      name,
      pcm16,
      sampleRate: sr,
      rootNote: root,
      loopStart: loopStartVal,
      loopEnd: loopEndVal,
      sampleMode, 
      noteRange: s.noteRange || [0, 127],
      channels: 1
    });
    idx++;
  }

  return allSamples;
}

/**
 * Build a naive note->sample map if needed
 */
function buildNoteToSampleMap(allSamples) {
  const map = new Array(128).fill(null);
  for (let note = 0; note < 128; note++) {
    // pick the first sample covering this note
    let chosen = null;
    for (const s of allSamples) {
      if (note >= s.noteRange[0] && note <= s.noteRange[1]) {
        chosen = s;
        break;
      }
    }
    // fallback to the closest root note
    if (!chosen) {
      let bestDiff = Infinity;
      for (const s of allSamples) {
        const diff = Math.abs(note - s.rootNote);
        if (diff < bestDiff) {
          bestDiff = diff;
          chosen = s;
        }
      }
    }
    map[note] = chosen;
  }
  return map;
}

/**
 * createSf2File
 *
 * Builds a minimal SoundFont with exactly one preset (0), one instrument (0), and
 * references the FIRST sample in 'allSamples' as a zone. The rest of the samples
 * are included in 'shdr' but not actually used in the instrument zone. 
 */
export function createSf2File(data) {
  // 1) Convert and gather samples
  const allSamples = prepareSamples(data);

  // 2) Build a note->sample mapping (unused in minimal example)
  const noteMap = buildNoteToSampleMap(allSamples);

  // 3) Allocate a large buffer
  const approximateSize = 4 * 1024 * 1024;
  const buffer = new ArrayBuffer(approximateSize);
  const view = new DataView(buffer);
  let offset = 0;

  function writeUint32(val) {
    view.setUint32(offset, val, true);
    offset += 4;
  }
  function writeUint16(val) {
    view.setUint16(offset, val, true);
    offset += 2;
  }
  function writeUint8(val) {
    view.setUint8(offset, val);
    offset += 1;
  }
  function writeFourCC(cc) {
    if (cc.length !== 4) throw new Error('FourCC must be 4 chars');
    for (let i = 0; i < 4; i++) {
      writeUint8(cc.charCodeAt(i));
    }
  }

  // Write a sub-chunk <id> <size> <payload> with alignment
  function writeChunk(id, payloadFn) {
    writeFourCC(id);
    const sizeOffset = offset;
    writeUint32(0); // placeholder
    const chunkStart = offset;

    payloadFn();

    let chunkEnd = offset;
    let chunkSize = chunkEnd - chunkStart;

    // Word alignment (2 bytes) for SF2
    if (chunkSize % 2 !== 0) {
      writeUint8(0);
      chunkEnd = offset;
      chunkSize++;
    }

    const savedPos = offset;
    offset = sizeOffset;
    writeUint32(chunkSize, true);
    offset = savedPos;
  }

  // -----------------------------------------------------
  //  Top-level RIFF chunk
  // -----------------------------------------------------
  writeFourCC('RIFF');
  const totalSizeOffset = offset;
  writeUint32(0); // placeholder for RIFF size
  writeFourCC('sfbk');

  // 1) LIST "INFO"
  writeChunk('LIST', () => {
    writeFourCC('INFO');

    // ifil
    writeChunk('ifil', () => {
      writeUint16(2); // Major
      writeUint16(1); // Minor
    });

    // isng
    writeChunk('isng', () => {
      const str = 'EMU8000';
      for (let i = 0; i < str.length; i++) {
        writeUint8(str.charCodeAt(i));
      }
      writeUint8(0);
    });

    // INAM
    writeChunk('INAM', () => {
      const name = data.name || 'Untitled SoundFont';
      for (let i = 0; i < name.length; i++) {
        writeUint8(name.charCodeAt(i));
      }
      writeUint8(0);
    });

    // IENG (author)
    if (data.author) {
      writeChunk('IENG', () => {
        const str = data.author;
        for (let i = 0; i < str.length; i++) {
          writeUint8(str.charCodeAt(i));
        }
        writeUint8(0);
      });
    }
  });

  // 2) LIST "sdta" => "smpl"
  writeChunk('LIST', () => {
    writeFourCC('sdta');
    writeChunk('smpl', () => {
      for (const s of allSamples) {
        const pcm = s.pcm16;
        // main data
        for (let i = 0; i < pcm.length; i++) {
          writeUint16(pcm[i]);
        }
        // guard frames (46)
        for (let i = 0; i < 46; i++) {
          writeUint16(0);
        }
      }
    });
  });

  // 3) LIST "pdta" => phdr, pbag, pmod, pgen, inst, ibag, imod, igen, shdr
  writeChunk('LIST', () => {
    writeFourCC('pdta');

    // phdr (Preset Header)
    writeChunk('phdr', () => {
      // One preset + terminal
      const presetName = data.name || 'Preset';
      // 1) Preset record (38 bytes)
      for (let i = 0; i < 20; i++) {
        writeUint8(i < presetName.length ? presetName.charCodeAt(i) : 0);
      }
      writeUint16(0); // preset=0
      writeUint16(0); // bank=0
      writeUint16(0); // wPresetBagNdx=0
      writeUint32(0); // dwLibrary
      writeUint32(0); // dwGenre
      writeUint32(0); // dwMorphology

      // Terminal record "EOP"
      const eopName = 'EOP';
      for (let i = 0; i < 20; i++) {
        writeUint8(i < eopName.length ? eopName.charCodeAt(i) : 0);
      }
      writeUint16(0);
      writeUint16(0);
      writeUint16(1); // pbag index
      writeUint32(0);
      writeUint32(0);
      writeUint32(0);
    });

    // pbag
    writeChunk('pbag', () => {
      // 1 bag + terminal
      writeUint16(0); // pgen index
      writeUint16(0); // pmod index
      // terminal
      writeUint16(1);
      writeUint16(0);
    });

    // pmod
    writeChunk('pmod', () => {
      // no modulators + terminal
      // 1 terminal record of 10 bytes
      for (let i = 0; i < 10; i++) {
        writeUint8(0);
      }
    });

    // pgen
    writeChunk('pgen', () => {
      // One generator => instrument #0, then terminal
      // GenOper=41 => instrument
      writeUint16(41);
      writeUint16(0); // instrument=0
      // terminal
      writeUint16(0);
      writeUint16(0);
    });

    // inst
    writeChunk('inst', () => {
      // 1 instrument => terminal
      const instName = data.name || 'Instrument';
      writeFixedAsciiString(view, offset, instName, 20);
      offset += 20;
      // ibag index
      writeUint16(0);

      // "EOI"
      writeFixedAsciiString(view, offset, 'EOI', 20);
      offset += 20;
      writeUint16(1);
    });

    // ibag
    writeChunk('ibag', () => {
      // 1 bag + terminal
      writeUint16(0); // igenIndex
      writeUint16(0); // imodIndex
      // terminal
      writeUint16(1);
      writeUint16(0);
    });

    // imod
    writeChunk('imod', () => {
      // no modulators + terminal
      for (let i = 0; i < 10; i++) {
        writeUint8(0);
      }
    });

    // igen
    writeChunk('igen', () => {
      // Single zone referencing the FIRST sample in allSamples
      if (allSamples.length > 0) {
        const firstSample = allSamples[0];
        // If it's looped, sampleModes => GenOper=54, amount=1 => loop_continuous
        if (firstSample.sampleMode === 1) {
          writeUint16(54); // sampleModes
          writeUint16(1);  // loop_continuous
        }

        // sampleID => GenOper=53
        // referencing sample #0 in shdr
        writeUint16(53);
        writeUint16(0);
      }
      // Terminal
      writeUint16(0);
      writeUint16(0);
    });

    // shdr (Sample Headers)
    writeChunk('shdr', () => {
      let startPos = 0;

      for (let i = 0; i < allSamples.length; i++) {
        const s = allSamples[i];
        const sampleName = s.name;

        // Write sample name (20 chars)
        writeFixedAsciiString(view, offset, sampleName, 20);
        offset += 20;

        const numFrames = s.pcm16.length;
        // The "guard" is 46 frames => total = numFrames + 46
        const endPos = startPos + numFrames;

        // Convert local loop points => absolute offsets
        const realLoopStart = startPos + s.loopStart;
        const realLoopEnd   = startPos + s.loopEnd;

        // 1) start
        writeUint32(startPos);
        // 2) end
        writeUint32(endPos);
        // 3) loopStart
        writeUint32(realLoopStart);
        // 4) loopEnd
        writeUint32(realLoopEnd);
        // 5) sampleRate
        writeUint32(s.sampleRate);
        // 6) originalPitch
        writeUint8(s.rootNote);
        // 7) pitchCorrection
        writeUint8(0);
        // 8) sampleLink
        writeUint16(0);
        // 9) sampleType (1=mono)
        writeUint16(1);

        // Move to next sample's region: + numFrames + guard
        startPos += (numFrames + 46);
      }

      // Terminal "EOS"
      writeFixedAsciiString(view, offset, 'EOS', 20);
      offset += 20;
      // Fill up rest (start, end, loopStart, loopEnd, sampleRate)
      for (let i = 0; i < 5; i++) {
        writeUint32(0);
      }
      // root, correction
      writeUint8(0);
      writeUint8(0);
      // link, type
      writeUint16(0);
      writeUint16(0);
    });
  });

  // Done writing. The file length is offset bytes.
  const fileEnd = offset;
  // By RIFF spec, the size after "RIFF" is (fileEnd - 8).
  const riffSize = fileEnd - 8;
  view.setUint32(totalSizeOffset, riffSize, true);

  // Return only the used portion as a Blob
  return new Blob([buffer.slice(0, fileEnd)], {
    type: 'application/octet-stream',
  });
}
