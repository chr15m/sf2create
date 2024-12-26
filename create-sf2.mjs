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
    // Trivial silent sample
    allSamples.push({
      name: 'Empty',
      pcm16: new Int16Array([0, 0, 0, 0]),
      sampleRate: 44100,
      rootNote: 60,
      loopStart: 0,
      loopEnd: 1,
      sampleMode: 0,      // no loop
      sampleLink: 0,      // no link
      sampleType: 1,      // mono
      channels: 1,
    });
    return allSamples;
  }

  let idx = 0;
  for (const userS of data.samples) {
    const name = userS.name || `sample_${idx}`;
    const sr = userS.sampleRate || 44100;
    const root = (userS.rootNote === undefined) ? 60 : userS.rootNote;

    // Decide loop info
    function computeLoop(numFrames) {
      let mode = 0, start = numFrames - 1, end = numFrames;
      if (
        typeof userS.loopStart === 'number' &&
        typeof userS.loopEnd === 'number' &&
        userS.loopEnd > userS.loopStart &&
        userS.loopStart >= 0 &&
        userS.loopEnd <= numFrames
      ) {
        mode = 1;
        start = userS.loopStart;
        end   = userS.loopEnd;
      }
      return {mode, start, end};
    }

    if (userS.channels === 2) {
      // ----- STEREO sample -----
      // We expect userS.rawStereoData: Float32Array interleaved [L0, R0, L1, R1, ...]
      const stereo = userS.rawStereoData || new Float32Array([0,0]);
      const numFrames = stereo.length / 2;
      // Split out left[] and right[] as Float32
      const leftF  = new Float32Array(numFrames);
      const rightF = new Float32Array(numFrames);
      for (let i = 0; i < numFrames; i++) {
        leftF[i]  = stereo[2*i];
        rightF[i] = stereo[2*i + 1];
      }
      // Convert to Int16
      const leftPCM  = float32ToInt16(leftF);
      const rightPCM = float32ToInt16(rightF);

      // Compute loop region (shared by both channels)
      const {mode, start, end} = computeLoop(numFrames);

      // Create the left-channel sample record
      const leftRecord = {
        name: name + ' L',
        pcm16: leftPCM,
        sampleRate: sr,
        rootNote: root,
        loopStart: start,
        loopEnd: end,
        sampleMode: mode,      
        sampleLink: 0,         // placeholder
        sampleType: 1,         // left channel
        channels: 2,           // user had 2
      };
      // Create the right-channel sample record
      const rightRecord = {
        name: name + ' R',
        pcm16: rightPCM,
        sampleRate: sr,
        rootNote: root,
        loopStart: start,
        loopEnd: end,
        sampleMode: mode,
        sampleLink: 0,         // placeholder
        sampleType: 2,         // right channel
        channels: 2,
      };

      // We'll push them in the array. We can fill in sampleLink afterwards once we know their final indexes.
      allSamples.push(leftRecord, rightRecord);

    } else {
      // ----- MONO sample -----
      const raw = userS.rawMonoData || new Float32Array([0]);
      const pcm16 = float32ToInt16(raw);
      const numFrames = pcm16.length;
      const {mode, start, end} = computeLoop(numFrames);

      allSamples.push({
        name: name,
        pcm16,
        sampleRate: sr,
        rootNote: root,
        loopStart: start,
        loopEnd: end,
        sampleMode: mode,
        sampleLink: 0,
        sampleType: 1,  // mono
        channels: 1,
      });
    }

    idx++;
  }

  // Now fix up sampleLink for stereo pairs
  // We'll iterate through allSamples. If we find consecutive entries
  // that share the same “parent name” + " L" / " R" and have channels=2, link them.
  // This is somewhat simplistic; you might want a more robust pairing approach.
  for (let i = 0; i < allSamples.length - 1; i++) {
    const s1 = allSamples[i];
    const s2 = allSamples[i+1];
    if (
      s1.channels === 2 &&
      s2.channels === 2 &&
      s1.name.endsWith(' L') &&
      s2.name.endsWith(' R') &&
      s1.name.slice(0, -2) === s2.name.slice(0, -2)
    ) {
      // s1 is left, s2 is right
      const leftIndex  = i;
      const rightIndex = i+1;
      s1.sampleLink = rightIndex;  // left links to right
      s2.sampleLink = leftIndex;   // right links to left
    }
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
        // Guard frames
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
      // in the "shdr" chunk
      for (let i = 0; i < allSamples.length; i++) {
        const s = allSamples[i];
        writeFixedAsciiString(view, offset, s.name, 20);
        offset += 20;

        const numFrames = s.pcm16.length;
        const endPos = startPos + numFrames;

        const realLoopStart = startPos + s.loopStart;
        const realLoopEnd   = startPos + s.loopEnd;

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
        writeUint16(s.sampleLink);
        // sampleType
        writeUint16(s.sampleType);

        // Move forward for the next sample's region
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
