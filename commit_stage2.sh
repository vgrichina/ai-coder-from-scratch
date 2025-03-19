#!/bin/sh
cp stage1/stage1_coder.js stage2/coder.js
cd stage2
cat ./prompt.txt | node ../stage1/stage1_coder.js --model 'anthropic/claude-3.7-sonnet' commit coder.js
