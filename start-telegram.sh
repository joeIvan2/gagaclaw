#!/bin/bash
cd "$(dirname "$0")"

if ! curl -s http://127.0.0.1:9229/json/version > /dev/null 2>&1; then
    echo "🚀 Starting Antigravity..."
    antigravity --no-sandbox --remote-debugging-port=9229 &
    sleep 5
fi

echo "📱 Starting Telegram Bot..."
while true; do
    node telegram.js
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -eq 42 ]; then
        echo ""
        echo "[Restart] Restarting telegram.js..."
        echo ""
    else
        echo "[$(date +%H:%M:%S)] telegram.js exited with code $EXIT_CODE"
        break
    fi
done
