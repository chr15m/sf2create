#!/bin/sh

npx mocha test-create-sf2.mjs
node create-sf2-from-wavs.mjs "TestBanjo" test-wavs/*.wav
sf2dump TestBanjo.sf2
fluidsynth -v -a null TestBanjo.sf2
