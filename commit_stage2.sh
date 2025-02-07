#!/bin/sh
cp stage1/stage1_coder.js stage2/coder.js
cat ./stage2/prompt.txt | node stage1/stage1_coder.js commit stage2/coder.js
