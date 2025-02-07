#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$OPENROUTER_API_KEY" ]; then
    echo "Error: OPENROUTER_API_KEY not set"
    exit 1
fi

BOOTSTRAP_DIR="$(cd "$SCRIPT_DIR/../bootstrap" && pwd)"
cat "$SCRIPT_DIR/advanced_coder_prompt.txt" "$BOOTSTRAP_DIR/coder.js" | "$BOOTSTRAP_DIR/ai-code" > "$SCRIPT_DIR/stage1_coder.js"
chmod +x "$SCRIPT_DIR/stage1_coder.js"

echo "Stage 1 coder generated in $SCRIPT_DIR/stage1_coder.js"
