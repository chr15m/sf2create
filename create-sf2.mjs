/**
 * create-sf2.mjs
 *
 * A high-level library to build SF2 (SoundFont v2) files in JavaScript,
 * returning them as a Blob. This version aggregates notes that map
 * to the same "closest sample" into a single zone, supports stereo,
 * includes global regions for OpenMPT, AND adds left/right pan.
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
 * with { pcm16, sampleRate, rootNote, loopStart, loopEnd, sampleMode, sampleLink, sampleType, ... }.
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
      sampleMode: 0, // no loop
      sampleLink: 0,
      sampleType: 1, // mono
      channels: 1,
    });
    return allSamples;
  }

  let idx = 0;
  for (const userS of data.samples) {
    const name = userS.name || `sample_${idx}`;
    const sr = userS.sampleRate || 44100;
    const root = (userS.rootNote === undefined) ? 60 : userS.rootNote;

    function computeLoop(numFrames) {
      let mode = 0,
        start = numFrames - 1,
        end = numFrames;
      if (
        typeof userS.loopStart === 'number' &&
        typeof userS.loopEnd === 'number' &&
        userS.loopEnd > userS.loopStart &&
        userS.loopStart >= 0 &&
        userS.loopEnd <= numFrames
      ) {
        mode = 1;
        start = userS.loopStart;
        end = userS.loopEnd;
      }
      return { mode, start, end };
    }

    if (userS.channels === 2) {
      // ----- STEREO sample -----
      const stereo = userS.rawStereoData || new Float32Array([0, 0]);
      const numFrames = stereo.length / 2;
      const leftF = new Float32Array(numFrames);
      const rightF = new Float32Array(numFrames);
      for (let i = 0; i < numFrames; i++) {
        leftF[i] = stereo[2 * i];
        rightF[i] = stereo[2 * i + 1];
      }
      const leftPCM = float32ToInt16(leftF);
      const rightPCM = float32ToInt16(rightF);

      const { mode, start, end } = computeLoop(numFrames);

      const leftRecord = {
        name: name.slice(0, 17).replaceAll(' ', '') + '_L',
        pcm16: leftPCM,
        sampleRate: sr,
        rootNote: root,
        loopStart: start,
        loopEnd: end,
        sampleMode: mode,
        sampleLink: 0,
        sampleType: 4, // left channel
        channels: 2,
      };
      const rightRecord = {
        name: name.slice(0, 17).replaceAll(' ', '') + '_R',
        pcm16: rightPCM,
        sampleRate: sr,
        rootNote: root,
        loopStart: start,
        loopEnd: end,
        sampleMode: mode,
        sampleLink: 0,
        sampleType: 2, // right channel
        channels: 2,
      };

      allSamples.push(leftRecord, rightRecord);
    } else {
      // ----- MONO sample -----
      const raw = userS.rawMonoData || new Float32Array([0]);
      const pcm16 = float32ToInt16(raw);
      const numFrames = pcm16.length;
      const { mode, start, end } = computeLoop(numFrames);

      allSamples.push({
        name: name,
        pcm16,
        sampleRate: sr,
        rootNote: root,
        loopStart: start,
        loopEnd: end,
        sampleMode: mode,
        sampleLink: 0,
        sampleType: 1, // mono
        channels: 1,
      });
    }

    idx++;
  }

  // Now fix up sampleLink for stereo pairs
  for (let i = 0; i < allSamples.length - 1; i++) {
    const s1 = allSamples[i];
    const s2 = allSamples[i + 1];
    if (
      s1.channels === 2 &&
      s2.channels === 2 &&
      s1.name.endsWith('_L') &&
      s2.name.endsWith('_R') &&
      s1.name.slice(0, -2) === s2.name.slice(0, -2)
    ) {
      const leftIndex = i;
      const rightIndex = i + 1;
      s1.sampleLink = rightIndex; // left links to right
      s2.sampleLink = leftIndex; // right links to left
    }
  }

  return allSamples;
}

// ---------------------------------------------------------------------------
// BUILDING ZONES & WRITING THE SF2
// ---------------------------------------------------------------------------

function buildNoteToSampleIndex(allSamples) {
  const roots = allSamples.map((s) => s.rootNote);
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

function buildInstrumentZones(allSamples, noteToSample) {
  const zones = [];

  function pushZonesForRange(lo, hi, sampleID) {
    // Create the main zone
    const mainZone = {
      keyLo: lo,
      keyHi: hi,
      sampleID,
      sampleMode: allSamples[sampleID].sampleMode,
      pan: 0, // default center
    };

    // If it's left or right, set a panning offset
    // e.g. -500 => 100% left, +500 => 100% right
    const s = allSamples[sampleID];
    if (s.sampleType === 4) {
      // left
      mainZone.pan = -500;
    } else if (s.sampleType === 2) {
      // right
      mainZone.pan = +500;
    }

    zones.push(mainZone);

    // If it's stereo left => also push a second zone for the right sample
    if (s.sampleType === 4 && s.sampleLink !== 0) {
      const rightID = s.sampleLink;
      const rightZone = {
        keyLo: lo,
        keyHi: hi,
        sampleID: rightID,
        sampleMode: allSamples[rightID].sampleMode,
        pan: +500, // about 50% right
      };
      zones.push(rightZone);
    }
  }

  let zoneStart = 0;
  let currSample = noteToSample[0];

  for (let note = 1; note < 128; note++) {
    const sID = noteToSample[note];
    if (sID !== currSample) {
      pushZonesForRange(zoneStart, note - 1, currSample);
      zoneStart = note;
      currSample = sID;
    }
  }
  pushZonesForRange(zoneStart, 127, currSample);

  return zones;
}

export function createSf2File(data) {
  // 1) Convert user samples -> allSamples
  const allSamples = prepareSamples(data);

  // 2) For each note [0..127], find the sample with the closest rootNote
  const noteMap = buildNoteToSampleIndex(allSamples);

  // 3) Create instrument zones (including stereo R if needed), with pan
  const zoneDefs = buildInstrumentZones(allSamples, noteMap);

  // 4) Write the SF2
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

  function writeChunk(id, payloadFn) {
    writeFourCC(id);
    const sizeOffset = offset;
    writeUint32(0); // placeholder
    const chunkStart = offset;

    payloadFn();

    let chunkEnd = offset;
    let chunkSize = chunkEnd - chunkStart;
    // word-align
    if (chunkSize % 2 !== 0) {
      writeUint8(0);
      chunkEnd++;
      chunkSize++;
    }
    const savedPos = offset;
    offset = sizeOffset;
    view.setUint32(offset, chunkSize, true);
    offset = savedPos;
  }

  // -----------------------------------------------------
  //  RIFF + sfbk
  // -----------------------------------------------------
  writeFourCC('RIFF');
  const totalSizeOffset = offset;
  writeUint32(0); // placeholder
  writeFourCC('sfbk');

  // -----------------------------------------------------
  //  LIST "INFO"
  // -----------------------------------------------------
  writeChunk('LIST', () => {
    writeFourCC('INFO');

    // ifil
    writeChunk('ifil', () => {
      writeUint16(2); // major
      writeUint16(1); // minor
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

  // -----------------------------------------------------
  //  LIST "sdta" => smpl
  // -----------------------------------------------------
  writeChunk('LIST', () => {
    writeFourCC('sdta');
    writeChunk('smpl', () => {
      for (const s of allSamples) {
        const pcm = s.pcm16;
        for (let i = 0; i < pcm.length; i++) {
          writeUint16(pcm[i]);
        }
        // 46 guard frames
        for (let i = 0; i < 46; i++) {
          writeUint16(0);
        }
      }
    });
  });

  // -----------------------------------------------------
  //  LIST "pdta"
  // -----------------------------------------------------
  writeChunk('LIST', () => {
    writeFourCC('pdta');

    // -------------------------
    // phdr
    // -------------------------
    writeChunk('phdr', () => {
      // 1 preset => global preset region => actual region => terminal
      const presetName = data.name || 'Preset';
      for (let i = 0; i < 20; i++) {
        writeUint8(i < presetName.length ? presetName.charCodeAt(i) : 0);
      }
      writeUint16(0); // preset=0
      writeUint16(0); // bank=0
      // wPresetBagNdx=0 => global preset bag
      writeUint16(0);
      writeUint32(0); // dwLibrary
      writeUint32(0); // dwGenre
      writeUint32(0); // dwMorphology

      // Terminal record
      const eopName = 'EOP';
      for (let i = 0; i < 20; i++) {
        writeUint8(i < eopName.length ? eopName.charCodeAt(i) : 0);
      }
      writeUint16(0);
      writeUint16(0);
      // 2 real preset bags => terminal is #2
      writeUint16(2);
      writeUint32(0);
      writeUint32(0);
      writeUint32(0);
    });

    // -------------------------
    // pbag
    // -------------------------
    writeChunk('pbag', () => {
      // Bag #0 => global => no gens
      writeUint16(0);
      writeUint16(0);

      // Bag #1 => references pgen #0 => instrument=0
      writeUint16(0);
      writeUint16(0);

      // Terminal => bag #2 => references pgen #1
      writeUint16(1);
      writeUint16(0);
    });

    // -------------------------
    // pmod
    // -------------------------
    writeChunk('pmod', () => {
      // no modulators + terminal
      for (let i = 0; i < 10; i++) {
        writeUint8(0);
      }
    });

    // -------------------------
    // pgen
    // -------------------------
    writeChunk('pgen', () => {
      // no gens for global
      // 1 gen => instrument=0 => GenOper=41
      writeUint16(41);
      writeUint16(0);
      // terminal
      writeUint16(0);
      writeUint16(0);
    });

    // -------------------------
    // inst
    // -------------------------
    writeChunk('inst', () => {
      // 1 instrument => global region => zoneDefs => then terminal
      const instName = data.name || 'Instrument';
      writeFixedAsciiString(view, offset, instName, 20);
      offset += 20;
      // wInstBagNdx=0 => global region
      writeUint16(0);

      // "EOI"
      writeFixedAsciiString(view, offset, 'EOI', 20);
      offset += 20;
      // zoneDefs.length+1 => plus 1 for global
      writeUint16(zoneDefs.length + 1);
    });

    // -------------------------
    // ibag
    // -------------------------
    writeChunk('ibag', () => {
      let genOffset = 0;

      // Bag #0 => global => no gens
      writeUint16(0);
      writeUint16(0);

      // Bags for each zone
      for (let i = 0; i < zoneDefs.length; i++) {
        writeUint16(genOffset);
        writeUint16(0);

        // keyRange + sampleID => 2 gens, plus loop => +1, plus pan => +1
        // Let’s see if it has loop => that’s 1 extra, if pan => that’s another extra.
        let count = 2; // keyRange + sampleID
        if (zoneDefs[i].sampleMode === 1) {
          count++;
        }
        // If pan != 0 => another generator
        if (zoneDefs[i].pan) {
          count++;
        }
        genOffset += count;
      }

      // terminal
      writeUint16(genOffset);
      writeUint16(0);
    });

    // -------------------------
    // imod
    // -------------------------
    writeChunk('imod', () => {
      // no modulators + terminal
      for (let i = 0; i < 10; i++) {
        writeUint8(0);
      }
    });

    // -------------------------
    // igen
    // -------------------------
    writeChunk('igen', () => {
      // Global => no gens
      for (const z of zoneDefs) {
        // keyRange => GenOper=43
        const keyRangeVal = (z.keyHi << 8) | z.keyLo;
        writeUint16(43);
        writeUint16(keyRangeVal);

        // if loop => sampleModes=54 => 1
        if (z.sampleMode === 1) {
          writeUint16(54);
          writeUint16(1);
        }

        // if pan != 0 => GenOper=17 => z.pan
        if (z.pan) {
          writeUint16(17); // pan
          writeUint16(z.pan);
        }

        // sampleID => GenOper=53
        writeUint16(53);
        writeUint16(z.sampleID);
      }

      // terminal
      writeUint16(0);
      writeUint16(0);
    });

    // -------------------------
    // shdr
    // -------------------------
    writeChunk('shdr', () => {
      let startPos = 0;
      for (let i = 0; i < allSamples.length; i++) {
        const s = allSamples[i];
        writeFixedAsciiString(view, offset, s.name, 20);
        offset += 20;

        const numFrames = s.pcm16.length;
        const endPos = startPos + numFrames;

        const realLoopStart = startPos + s.loopStart;
        const realLoopEnd = startPos + s.loopEnd;

        writeUint32(startPos);
        writeUint32(endPos);
        writeUint32(realLoopStart);
        writeUint32(realLoopEnd);
        writeUint32(s.sampleRate);
        writeUint8(s.rootNote);
        writeUint8(0); // pitchCorrection
        writeUint16(s.sampleLink);
        writeUint16(s.sampleType);

        startPos += numFrames + 46;
      }

      // Terminal sample => "EOS"
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

  const fileEnd = offset;
  const riffSize = fileEnd - 8;
  view.setUint32(totalSizeOffset, riffSize, true);

  return new Blob([buffer.slice(0, fileEnd)], {
    type: 'application/octet-stream',
  });
}
