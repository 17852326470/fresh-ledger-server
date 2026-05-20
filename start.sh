#!/bin/bash
# 启动呱呱超市云端服务

cd "$(dirname "$0")"

# 1. 启动后端服务
echo "🚀 启动生鲜台账服务..."
node server.js &
SERVER_PID=$!
sleep 2

# 2. 启动内网穿透
echo "🔗 启动内网穿透..."
/Users/suhao/.openclaw/workspace/bore local 3100 --to bore.pub &
BORE_PID=$!
sleep 3

echo ""
echo "✅ 服务已启动！"
echo "   本地地址: http://localhost:3100/"
echo "   外网地址: http://bore.pub:1213/"
echo ""
echo "按 Ctrl+C 停止所有服务"

# 等待任一进程退出
wait $SERVER_PID $BORE_PID
