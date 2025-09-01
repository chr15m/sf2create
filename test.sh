#!/bin/sh

npx mocha test-create-sf2.mjs

# The following commands test the CLI tool. They will only succeed if you have
# .wav files in test-wavs/ and test-drum-wavs/ directories.
# It's safe for them to fail if these directories are empty.

# Test melodic instrument creation
if ls test-stereo-wavs/*.wav >/dev/null 2>&1; then
    echo "\n--- Testing melodic instrument creation ---"
    node create-sf2-from-wavs.mjs "TestBanjo" test-stereo-wavs/*.wav
    sf2dump TestBanjo.sf2
    fluidsynth -v -a null TestBanjo.sf2
    rm TestBanjo.sf2
fi

# Test drum kit creation
if ls test-drum-wavs/*.wav >/dev/null 2>&1; then
    echo "\n--- Testing drum kit creation ---"
    node create-sf2-from-wavs.mjs --drums "TestDrums" test-drum-wavs/*.wav
    sf2dump TestDrums.sf2
    fluidsynth -v -a null TestDrums.sf2
    rm TestDrums.sf2
fi
