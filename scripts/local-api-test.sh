#!/usr/bin/env bash
# 本地联调脚本：start -> upload-image -> llm-proxy -> stop
# 使用前请先 npm run dev，并确保 .env 中 NEXT_PUBLIC_ZEGO_APP_ID、ZEGO_SERVER_SECRET 已填写（start 需要）

set -e
BASE_URL="${BASE_URL:-http://localhost:3000}"
USER_ID="${USER_ID:-user_local_1}"
ROOM_ID="${ROOM_ID:-room_local_1}"
USER_STREAM_ID="${USER_STREAM_ID:-user_stream_1}"

echo "=== 1. 获取 ZEGO Token (GET /api/zego-token) ==="
TOKEN_RES=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/zego-token?userId=${USER_ID}")
HTTP_CODE=$(echo "$TOKEN_RES" | tail -n1)
BODY=$(echo "$TOKEN_RES" | sed '$d')
echo "HTTP $HTTP_CODE"
echo "$BODY" | head -c 200
echo ""
echo ""

echo "=== 2. 启动 Agent 实例 (POST /api/start) ==="
START_RES=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/start" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"${USER_ID}\",\"room_id\":\"${ROOM_ID}\",\"user_stream_id\":\"${USER_STREAM_ID}\"}")
START_HTTP=$(echo "$START_RES" | tail -n1)
START_BODY=$(echo "$START_RES" | sed '$d')
echo "HTTP $START_HTTP"
echo "$START_BODY"
AGENT_INSTANCE_ID=$(echo "$START_BODY" | grep -o '"agent_instance_id":"[^"]*"' | cut -d'"' -f4)
if [ -z "$AGENT_INSTANCE_ID" ]; then
  echo "未获取到 agent_instance_id，将使用环境变量 AGENT_INSTANCE_ID（若有）。"
  echo "仅测上传/LLM 时可执行: export AGENT_INSTANCE_ID=你的实例ID"
  echo ""
else
  echo "agent_instance_id=$AGENT_INSTANCE_ID"
  echo ""
fi

read -r -p "按 Enter 继续执行第 3 步（上传图片）..."
echo "=== 3. 上传图片 (POST /api/upload-image) ==="
# 使用项目 images 目录下的 deploy-site.png 作为测试图片
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_IMG="${TEST_IMAGE_PATH:-${SCRIPT_DIR}/../images/deploy-site.png}"
if [ ! -f "$TEST_IMG" ] || [ ! -s "$TEST_IMG" ]; then
  echo "测试图片不存在: $TEST_IMG，可设置: export TEST_IMAGE_PATH=/path/to/image.png"
  TEST_IMG=""
fi
if [ -n "$AGENT_INSTANCE_ID" ] && [ -f "$TEST_IMG" ] && [ -s "$TEST_IMG" ]; then
  UPLOAD_RES=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/upload-image" \
    -F "agent_instance_id=${AGENT_INSTANCE_ID}" \
    -F "image=@${TEST_IMG}")
  UPLOAD_HTTP=$(echo "$UPLOAD_RES" | tail -n1)
  UPLOAD_BODY=$(echo "$UPLOAD_RES" | sed '$d')
  echo "HTTP $UPLOAD_HTTP"
  echo "$UPLOAD_BODY"
else
  echo "跳过上传（无 agent_instance_id 或测试图片）。可手动执行："
  echo "  curl -X POST ${BASE_URL}/api/upload-image -F 'agent_instance_id=实例ID' -F 'image=@/path/to/image.png'"
fi
echo ""

echo "=== 4. 调用 LLM 代理 (POST /api/llm-proxy，模拟 ZEGO 带 agent_info) ==="
LLM_BODY=$(cat <<EOF
{
  "model": "anthropic/claude-sonnet-4.6",
  "messages": [
    { "role": "system", "content": "你是一个简短回复的助手。" },
    { "role": "user", "content": "我要怎么进行开仓？" }
  ],
  "agent_info": {
    "agent_instance_id": "${AGENT_INSTANCE_ID}",
    "user_id": "${USER_ID}",
    "room_id": "${ROOM_ID}"
  }
}
EOF
)
if [ -z "$AGENT_INSTANCE_ID" ]; then
  echo "无 agent_instance_id，使用 body 仅含 user_id 测试（依赖 store 中 user->instance 映射）"
  LLM_BODY=$(cat <<EOF
{
  "model": "anthropic/claude-sonnet-4.6",
  "user_id": "${USER_ID}",
  "messages": [
    { "role": "system", "content": "你是一个简短回复的助手。" },
    { "role": "user", "content": "你好，请说一句话。" }
  ]
}
EOF
)
fi
LLM_RES=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/llm-proxy" \
  -H "Content-Type: application/json" \
  -d "$LLM_BODY")
LLM_HTTP=$(echo "$LLM_RES" | tail -n1)
LLM_BODY_RES=$(echo "$LLM_RES" | sed '$d')
echo "HTTP $LLM_HTTP"
echo "$LLM_BODY_RES" | head -c 500
echo ""
echo ""

echo "=== 5. 停止 Agent 实例 (POST /api/stop) ==="
STOP_BODY="{}"
[ -n "$AGENT_INSTANCE_ID" ] && STOP_BODY="{\"agent_instance_id\":\"${AGENT_INSTANCE_ID}\"}"
STOP_RES=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/stop" \
  -H "Content-Type: application/json" \
  -d "$STOP_BODY")
STOP_HTTP=$(echo "$STOP_RES" | tail -n1)
STOP_BODY_RES=$(echo "$STOP_RES" | sed '$d')
echo "HTTP $STOP_HTTP"
echo "$STOP_BODY_RES"
echo ""
echo "=== 联调结束 ==="
