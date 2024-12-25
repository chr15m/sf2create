/**
 * create-sf2.mjs
 *
 * A high-level library to build SF2 (SoundFont v2) files in JavaScript,
 * returning them as a Blob. This version aggregates notes that map
 * to the same "closest sample" into a single zone.
 */

// 0. Helpful utilities

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

function writeFixedAsciiString(view, offset, str, length) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str.slice(0, length));
  let i = 0;
  for (; i < bytes.length && i < length; i++) {
    view.setUint8(offset + i, bytes[i]);
  }
  for (; i < length; i++) {
    view.setUint8(offset + i, 0);
  }
}

/**
 * Convert the user’s sample data => an array of objects
 * with { pcm16, sampleRate, rootNote, loopStart, loopEnd, sampleMode, ... }
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
      loopEnd: 1, // minimal region
      sampleMode: 0, // no loop
      channels: 1
    });
    return allSamples;
  }

  // Optionally sort by rootNote (useful for debugging)
  const userSamples = data.samples.slice().sort((a, b) => {
    const rA = (a.rootNote == null) ? 60 : a.rootNote;
    const rB = (b.rootNote == null) ? 60 : b.rootNote;
    return rA - rB;
  });

  let idx = 0;
  for (const s of userSamples) {
    const rawMonoData = s.rawMonoData || new Float32Array([0]);
    const pcm16 = float32ToInt16(rawMonoData);
    const numFrames = pcm16.length;
    const name = s.name || `sample_${idx}`;
    const sr = s.sampleRate || 44100;
    const root = (s.rootNote === undefined) ? 60 : s.rootNote;

    // Default: no loop
    let sampleMode = 0;
    let loopStartVal = numFrames - 1;
    let loopEndVal = numFrames;

    // If user gave valid loop points => continuous loop
    if (
      typeof s.loopStart === 'number' &&
      typeof s.loopEnd === 'number' &&
      s.loopEnd > s.loopStart &&
      s.loopStart >= 0 &&
      s.loopEnd <= numFrames
    ) {
      sampleMode = 1;
      loopStartVal = s.loopStart;
      loopEndVal = s.loopEnd;
    }

    allSamples.push({
      name,
      pcm16,
      sampleRate: sr,
      rootNote: root,
      loopStart: loopStartVal,
      loopEnd: loopEndVal,
      sampleMode,
      channels: 1
    });
    idx++;
  }

  return allSamples;
}

/**
 * Create note->sample mapping by picking the sample with the *closest* rootNote to each MIDI note.
 *
 * Returns an array of length 128. Each entry is the index in allSamples that is the best match.
 */
function buildNoteToSampleIndex(allSamples) {
  // For convenience, store the rootNote of each sample
  const roots = allSamples.map(s => s.rootNote);

  const map = new Array(128);
  for (let note = 0; note < 128; note++) {
    let bestSampleID = 0;
    let bestDiff = Infinity;

    for (let sIdx = 0; sIdx < allSamples.length; sIdx++) {
      const diff = Math.abs(note - roots[sIdx]);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestSampleID = sIdx;
      }
    }
    map[note] = bestSampleID;
  }
  return map;
}

/**
 * Build a set of instrument zones (key ranges) from the note->sample mapping.
 * We'll group consecutive notes that map to the same sample into one zone.
 *
 * Returns an array of zone objects of the form:
 *   {
 *     keyLo: number,
 *     keyHi: number,
 *     sampleID: number,
 *     sampleMode: 0|1
 *   }
 */
function buildInstrumentZones(allSamples, noteToSample) {
  const zones = [];
  let currSample = noteToSample[0];
  let zoneStart = 0;

  for (let note = 1; note < 128; note++) {
    const sID = noteToSample[note];
    if (sID !== currSample) {
      // close out the previous zone
      zones.push({
        keyLo: zoneStart,
        keyHi: note - 1,
        sampleID: currSample,
        sampleMode: allSamples[currSample].sampleMode
      });
      // start a new zone
      zoneStart = note;
      currSample = sID;
    }
  }

  // final zone
  zones.push({
    keyLo: zoneStart,
    keyHi: 127,
    sampleID: currSample,
    sampleMode: allSamples[currSample].sampleMode
  });

  return zones;
}

export function createSf2File(data) {
  // 1) Convert user samples -> allSamples
  const allSamples = prepareSamples(data);

  // 2) For each note [0..127], find the sample with the closest rootNote
  const noteMap = buildNoteToSampleIndex(allSamples);

  // 3) Group consecutive notes that share the same sample => instrument zones
  const zoneDefs = buildInstrumentZones(allSamples, noteMap);

  // 4) Prepare to write the SF2
  const approximateSize = 4 * 1024 * 1024;
  const buffer = new ArrayBuffer(approximateSize);
  const view = new DataView(buffer);
  let offset = 0;

  // Helper writers
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

  function writeChunk(id, payloadFn) {
    writeFourCC(id);
    const sizeOffset = offset;
    writeUint32(0); // placeholder
    const chunkStart = offset;

    payloadFn();

    let chunkEnd = offset;
    let chunkSize = chunkEnd - chunkStart;
    // Word align
    if (chunkSize % 2 !== 0) {
      writeUint8(0);
      chunkEnd++;
      chunkSize++;
    }
    const savedPos = offset;
    offset = sizeOffset;
    writeUint32(chunkSize, true);
    offset = savedPos;
  }

  // ------------------------
  // RIFF + sfbk
  // ------------------------
  writeFourCC('RIFF');
  const totalSizeOffset = offset;
  writeUint32(0); // placeholder
  writeFourCC('sfbk');

  // ------------------------
  // LIST "INFO"
  // ------------------------
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

  // ------------------------
  // LIST "sdta" => smpl
  // ------------------------
  writeChunk('LIST', () => {
    writeFourCC('sdta');
    writeChunk('smpl', () => {
      // Write each sample + 46 guard points
      for (const s of allSamples) {
        const pcm = s.pcm16;
        for (let i = 0; i < pcm.length; i++) {
          writeUint16(pcm[i]);
        }
        // Guard frames (46)
        for (let i = 0; i < 46; i++) {
          writeUint16(0);
        }
      }
    });
  });

  // ------------------------
  // LIST "pdta"
  // ------------------------
  writeChunk('LIST', () => {
    writeFourCC('pdta');

    // ---- phdr ----
    writeChunk('phdr', () => {
      // We create exactly 1 preset + terminal
      const presetName = data.name || 'Preset';
      // Preset record (38 bytes)
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
      writeUint16(1); // pbag index => after 1 bag
      writeUint32(0);
      writeUint32(0);
      writeUint32(0);
    });

    // ---- pbag ----
    writeChunk('pbag', () => {
      // 1 bag + terminal => 2 records total
      // bag #0 => references pgen #0
      writeUint16(0); // wGenNdx
      writeUint16(0); // wModNdx
      // terminal
      writeUint16(1);
      writeUint16(0);
    });

    // ---- pmod ----
    writeChunk('pmod', () => {
      // no modulators + terminal
      for (let i = 0; i < 10; i++) {
        writeUint8(0);
      }
    });

    // ---- pgen ----
    writeChunk('pgen', () => {
      // One generator => instrument=0
      // GenOper=41 => instrument
      writeUint16(41);
      writeUint16(0);
      // terminal
      writeUint16(0);
      writeUint16(0);
    });

    // ---- inst ----
    writeChunk('inst', () => {
      // 1 instrument => name, wInstBagNdx=0 => then terminal
      const instName = data.name || 'Instrument';
      writeFixedAsciiString(view, offset, instName, 20);
      offset += 20;
      // wInstBagNdx => first bag
      writeUint16(0);

      // "EOI"
      writeFixedAsciiString(view, offset, 'EOI', 20);
      offset += 20;
      // wInstBagNdx => zoneDefs.length => next after all zones
      writeUint16(zoneDefs.length);
    });

    // ---- ibag ----
    writeChunk('ibag', () => {
      // We'll create one bag per zone, plus a terminal bag
      // Each bag references the next generator index (in IGEN)
      let genOffset = 0;

      // For each zone, we might have 2 or 3 generators:
      //   keyRange (GenOper=43)
      //   [sampleModes if looped => GenOper=54]
      //   sampleID (GenOper=53)
      for (let i = 0; i < zoneDefs.length; i++) {
        writeUint16(genOffset); // wInstGenNdx
        writeUint16(0);         // wInstModNdx => no modulators
        // Count how many gens
        let count = 2; // keyRange + sampleID
        if (zoneDefs[i].sampleMode === 1) {
          count++;
        }
        genOffset += count;
      }

      // Terminal bag
      writeUint16(genOffset);
      writeUint16(0);
    });

    // ---- imod ----
    writeChunk('imod', () => {
      // no modulators + terminal
      for (let i = 0; i < 10; i++) {
        writeUint8(0);
      }
    });

    // ---- igen ----
    writeChunk('igen', () => {
      // For each zone => keyRange, optional sampleModes, sampleID
      for (const z of zoneDefs) {
        // keyRange => GenOper=43
        // 16-bit param: (hi << 8) | lo
        const keyRangeVal = (z.keyHi << 8) | z.keyLo;
        writeUint16(43);
        writeUint16(keyRangeVal);

        // If loop => sampleModes => GenOper=54, value=1
        if (z.sampleMode === 1) {
          writeUint16(54);
          writeUint16(1); // loop_continuous
        }

        // sampleID => GenOper=53
        writeUint16(53);
        writeUint16(z.sampleID);
      }

      // Terminal generator
      writeUint16(0);
      writeUint16(0);
    });

    // ---- shdr ----
    writeChunk('shdr', () => {
      let startPos = 0;
      for (let i = 0; i < allSamples.length; i++) {
        const s = allSamples[i];
        const sampleName = s.name;

        // Write sample name (20 chars)
        writeFixedAsciiString(view, offset, sampleName, 20);
        offset += 20;

        const numFrames = s.pcm16.length;
        const endPos = startPos + numFrames;

        // Convert local loop => absolute offsets
        const realLoopStart = startPos + s.loopStart;
        const realLoopEnd = startPos + s.loopEnd;

        // start
        writeUint32(startPos);
        // end
        writeUint32(endPos);
        // loopStart
        writeUint32(realLoopStart);
        // loopEnd
        writeUint32(realLoopEnd);
        // sampleRate
        writeUint32(s.sampleRate);
        // originalPitch
        writeUint8(s.rootNote);
        // pitchCorrection
        writeUint8(0);
        // sampleLink
        writeUint16(0);
        // sampleType => 1=mono
        writeUint16(1);

        // Move forward in the PCM data region
        startPos += (numFrames + 46);
      }

      // Terminal sample: "EOS"
      writeFixedAsciiString(view, offset, 'EOS', 20);
      offset += 20;
      for (let i = 0; i < 5; i++) {
        writeUint32(0);
      }
      writeUint8(0);
      writeUint8(0);
      writeUint16(0);
      writeUint16(0);
    });
  });

  // Finalize
  const fileEnd = offset;
  const riffSize = fileEnd - 8; // after "RIFF"
  view.setUint32(totalSizeOffset, riffSize, true);

  return new Blob([buffer.slice(0, fileEnd)], {
    type: 'application/octet-stream',
  });
}
