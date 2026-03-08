#!/bin/bash
cd "$(dirname "$0")"

if ! curl -s http://127.0.0.1:9229/json/version > /dev/null 2>&1; then
    echo "🚀 Starting Antigravity..."
    antigravity --no-sandbox --remote-debugging-port=9229 &
    sleep 5
fi

echo "⏰ Starting Cron Scheduler..."
while true; do
    node cron.js
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -eq 42 ]; then
        echo ""
        echo "[Restart] Restarting cron.js..."
        echo ""
    else
        echo "[$(date +%H:%M:%S)] cron.js exited with code $EXIT_CODE"
        break
    fi
done
