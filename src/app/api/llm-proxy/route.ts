import { NextRequest, NextResponse } from "next/server";
import { AgentStore } from "@/lib/store";

type ContentPart = {
  type: string;
  text?: string;
  image_url?: {
    url: string;
  };
};

type ChatMessage = {
  role?: string;
  content?: string | ContentPart[];
};

interface ChatRequestBody {
  model?: string;
  user?: string;
  user_id?: string;
  agent_instance_id?: string;
  AgentInstanceId?: string;
  agent_info?: {
    agent_instance_id?: string;
    user_id?: string;
    [key: string]: unknown;
  };
  messages?: ChatMessage[];
  [key: string]: unknown;
}

const DEFAULT_UPSTREAM_URL = "https://openrouter.ai/api/v1/chat/completions";

/** 加密货币交易所教学帮助人员 - 默认 system prompt（可通过 LLM_PROXY_SYSTEM_PROMPT 覆盖） */
const DEFAULT_SYSTEM_PROMPT_CRYPTO =
  "回答问题要求：你在做角色扮演，请按照人设要求与用户对话，直接输出回答，回答时以句号为维度，单次回答最长不要超过3句，不能超过100字。\n" +
  "若用户提供了图片，请结合图片内容回答；若未提供图片，仅根据文字回答即可。\n" +
  "角色：林晓数\n" +
  "绰号：小林老师\n" +
  "性别：女\n" +
  "出身背景：林晓数出身于金融科技行业，曾在多家头部交易所负责用户教育与风控，对加密货币交易与安全有多年实战经验。\n" +
  "性格特点：耐心细致，对新手问题从不厌烦；严谨负责，强调风险与合规；热情专业，用通俗语言讲清复杂概念。\n" +
  "语言风格：条理清晰，能把交易、钱包、合约等概念讲得易懂；准确流畅，不夸大收益、不回避风险；富有感染力，让用户对理性参与交易产生信心。\n" +
  "人际关系：在交易所与社区拥有良好口碑。与用户相处如同顾问，关心他们的资产安全；与同事合作默契，共同推动用户教育。\n" +
  "过往经历：大学主修金融，毕业后进入交易所做运营与用户教育，至今已有 8 年经验。擅长从零讲解现货、合约、钱包、安全与合规，帮助众多用户建立正确交易观念。\n" +
  "经典台词：\n" +
  '1. "先搞懂再动手，本金安全第一。"\n' +
  '2. "交易所只是工具，理性与纪律才是你的护城河。"\n' +
  '3. "不懂的别碰，小仓位试错，别梭哈。"\n' +
  "对话示例：\n" +
  "1. 用户：小林老师，什么是合约啊？\n" +
  "林晓数：合约是一种衍生品，用保证金放大盈亏。先学好现货和风险，再考虑合约不迟。\n" +
  "2. 用户：老师，我总怕爆仓。\n" +
  "林晓数：控制仓位、设好止损，别扛单。先把这些习惯养成，再谈赚多少。\n" +
  "3. 用户：交易所会不会跑路？\n" +
  "林晓数：选持牌、有储备金披露的大所，资产分散放，不把鸡蛋放一个篮子。\n" +
  "4. 用户：怎么提币最安全？\n" +
  "林晓数：核对地址、先小额测试、别点陌生链接。钱包和验证码自己保管好。\n" +
  "5. 用户：老师，我想参加交易大赛。\n" +
  "林晓数：可以，当练手和学规则就好，别把比赛当实盘梭哈。\n";

function parseAuthorizationToken(request: NextRequest): string {
  const authHeader = request.headers.get("authorization") || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return "";
  return token.trim();
}

// 优先使用 agent_info.agent_instance_id（ZEGO/脚本都会带），再 fallback 到 query/header/body；统一转成 string（JSON 可能解析为 number）
function resolveAgentInstanceId(request: NextRequest, body: ChatRequestBody): string {
  const fromAgentInfo =
    body.agent_info?.agent_instance_id != null
      ? String(body.agent_info.agent_instance_id).trim()
      : "";
  const queryId = new URL(request.url).searchParams.get("agent_instance_id");
  const headerId = request.headers.get("x-agent-instance-id");
  const bodyId = body.agent_instance_id != null ? String(body.agent_instance_id).trim() : "";
  const bodyIdPascal = body.AgentInstanceId != null ? String(body.AgentInstanceId).trim() : "";
  return (fromAgentInfo || queryId || headerId || bodyId || bodyIdPascal || "").trim();
}

function resolveUserId(body: ChatRequestBody): string {
  if (typeof body.user === "string" && body.user.trim()) return body.user.trim();
  if (typeof body.user_id === "string" && body.user_id.trim()) return body.user_id.trim();
  if (typeof body.agent_info?.user_id === "string" && body.agent_info.user_id.trim()) {
    return body.agent_info.user_id.trim();
  }
  return "";
}

function injectImageIntoLastUserMessage(messages: ChatMessage[], imageDataURL: string): ChatMessage[] {
  const nextMessages = [...messages];
  let targetIndex = -1;
  for (let i = nextMessages.length - 1; i >= 0; i -= 1) {
    if (nextMessages[i]?.role === "user") {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex < 0) return nextMessages;

  const targetMessage = nextMessages[targetIndex];
  const currentContent = targetMessage.content;
  // OpenRouter/OpenAI 兼容：url 支持 base64 data URL（data:image/jpeg;base64,... 或 data:image/png;base64,...）
  const imagePart: ContentPart = {
    type: "image_url",
    image_url: {
      url: imageDataURL,
    },
  };

  let nextContent: ContentPart[];
  if (typeof currentContent === "string") {
    nextContent = [
      { type: "text", text: currentContent },
      imagePart,
    ];
  } else if (Array.isArray(currentContent)) {
    const withoutImageParts = currentContent.filter((part) => part?.type !== "image_url");
    nextContent = [...withoutImageParts, imagePart];
  } else {
    nextContent = [imagePart];
  }

  nextMessages[targetIndex] = {
    ...targetMessage,
    content: nextContent,
  };

  return nextMessages;
}

function withInjectedImage(body: ChatRequestBody, imageDataURL: string): ChatRequestBody {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return body;

  return {
    ...body,
    messages: injectImageIntoLastUserMessage(messages, imageDataURL),
  };
}

export async function POST(request: NextRequest) {
  try {
    const expectedInboundToken = process.env.LLM_PROXY_AUTH_TOKEN || "";
    if (expectedInboundToken) {
      const inboundToken = parseAuthorizationToken(request);
      if (inboundToken !== expectedInboundToken) {
        return NextResponse.json(
          {
            code: 401,
            message: "unauthorized",
          },
          { status: 401 }
        );
      }
    }

    const body = (await request.json()) as ChatRequestBody;
    const store = AgentStore.getInstance();

    let agentInstanceId = resolveAgentInstanceId(request, body);
    if (!agentInstanceId) {
      const userId = resolveUserId(body);
      if (userId) {
        agentInstanceId = store.getAgentInstanceIdByUserId(userId);
      }
    }

    const imageInstanceIds = store.getImageInstanceIds();
    console.log("[llm-proxy] images in memory (instance_ids):", imageInstanceIds.length ? imageInstanceIds : "(none)");
    const imageDataURL = agentInstanceId ? store.getLatestImageDataURL(agentInstanceId) : "";
    console.log("[llm-proxy] agent_instance_id from agent_info/request:", agentInstanceId || "(none)", "hasImage:", !!imageDataURL);
    const payload = imageDataURL ? withInjectedImage(body, imageDataURL) : body;

    // 使用加密货币交易所教学帮助人员 system prompt（支持 .env LLM_PROXY_SYSTEM_PROMPT 覆盖）
    const systemPrompt =
      (typeof process.env.LLM_PROXY_SYSTEM_PROMPT === "string" && process.env.LLM_PROXY_SYSTEM_PROMPT.trim()) ||
      DEFAULT_SYSTEM_PROMPT_CRYPTO;
    const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];
    const systemIndex = messages.findIndex((m) => m?.role === "system");
    const systemMessage = { role: "system" as const, content: systemPrompt };
    if (systemIndex >= 0) {
      messages[systemIndex] = systemMessage;
    } else {
      messages.unshift(systemMessage);
    }
    payload.messages = messages;

    // 优先使用 .env 中的模型，保证代理侧配置生效（覆盖 ZEGO/客户端传入的 model）
    if (process.env.LLM_PROXY_UPSTREAM_MODEL) {
      payload.model = process.env.LLM_PROXY_UPSTREAM_MODEL;
    }

    const upstreamURL = process.env.LLM_PROXY_UPSTREAM_URL || DEFAULT_UPSTREAM_URL;
    const upstreamAPIKey = process.env.LLM_PROXY_UPSTREAM_API_KEY || "";
    if (!upstreamAPIKey) {
      return NextResponse.json(
        {
          code: 500,
          message: "LLM_PROXY_UPSTREAM_API_KEY is required",
        },
        { status: 500 }
      );
    }

    // 打印发往第三方 API 的完整请求体（base64 图片用占位符，避免刷屏）
    const bodyForLog = (() => {
      const copy = JSON.parse(JSON.stringify(payload)) as ChatRequestBody;
      const m = copy.messages;
      if (Array.isArray(m)) {
        for (const msg of m) {
          const c = msg.content;
          if (Array.isArray(c)) {
            for (const part of c) {
              if (part?.type === "image_url" && part.image_url?.url) {
                const len = part.image_url.url.length;
                part.image_url = { url: `[base64 image, ${len} chars]` };
              }
            }
          }
        }
      }
      return copy;
    })();
    console.log("[llm-proxy] request to upstream:", upstreamURL);
    console.log("[llm-proxy] request body:", JSON.stringify(bodyForLog, null, 2));
    console.log("[llm-proxy] Authorization: Bearer ..." + (upstreamAPIKey.slice(-4) || ""));

    const response = await fetch(upstreamURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamAPIKey}`,
        ...(process.env.OPENROUTER_SITE_URL ? { "HTTP-Referer": process.env.OPENROUTER_SITE_URL } : {}),
        ...(process.env.OPENROUTER_APP_NAME ? { "X-Title": process.env.OPENROUTER_APP_NAME } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.log("[llm-proxy] upstream error:", response.status, errText.slice(0, 500));
      const contentType = response.headers.get("content-type") || "application/json";
      return new NextResponse(errText, { status: response.status, headers: { "Content-Type": contentType } });
    }

    // 直接透传上游响应体，兼容 SSE 流式输出（ZEGO 自定义 LLM 要求）
    const headers = new Headers();
    const contentType = response.headers.get("content-type");
    if (contentType) headers.set("Content-Type", contentType);
    const cacheControl = response.headers.get("cache-control");
    if (cacheControl) headers.set("Cache-Control", cacheControl);
    const connection = response.headers.get("connection");
    if (connection) headers.set("Connection", connection);

    if (response.body) {
      return new NextResponse(response.body, {
        status: response.status,
        headers,
      });
    }

    const fallbackText = await response.text();
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return new NextResponse(fallbackText, {
      status: response.status,
      headers,
    });
  } catch (error) {
    console.error("llm proxy failed:", error);
    return NextResponse.json(
      {
        code: 500,
        message: (error as Error).message || "llm proxy failed",
      },
      { status: 500 }
    );
  }
}
