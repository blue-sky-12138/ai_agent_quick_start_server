import { NextRequest, NextResponse } from "next/server";
import { AgentStore } from "@/lib/store";
import { insertLlmLog } from "@/lib/db";
import OpenAI from "openai";
import {
  buildOpenAiNonStreamCompletionJson,
  getLastAssistantText,
  getRagKbMode,
  getRagKbReChat,
  getRagKbAuthHeaders,
  isUserIdAllowedForRagKb,
  ragKbChatCompletionAuto,
  runRagKbToolLoop,
  serializeMessagesForRag,
  writeOpenAiSseStreamFromText,
} from "@/lib/rag-kb";

// ─── Types ───────────────────────────────────────────────────────────────────

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
  stream?: boolean;
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

// ─── Default system prompt ────────────────────────────────────────────────────

/** 加密货币交易所教学帮助人员 - 默认 system prompt（可通过 LLM_PROXY_SYSTEM_PROMPT 覆盖） */
const DEFAULT_SYSTEM_PROMPT =
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

// 优先使用 agent_info.agent_instance_id，再 fallback 到 query/header/body；统一转成 string
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
  const imagePart: ContentPart = {
    type: "image_url",
    image_url: { url: imageDataURL },
  };

  let nextContent: ContentPart[];
  if (typeof currentContent === "string") {
    nextContent = [{ type: "text", text: currentContent }, imagePart];
  } else if (Array.isArray(currentContent)) {
    const withoutImageParts = currentContent.filter((part) => part?.type !== "image_url");
    nextContent = [...withoutImageParts, imagePart];
  } else {
    nextContent = [imagePart];
  }

  nextMessages[targetIndex] = { ...targetMessage, content: nextContent };
  return nextMessages;
}

function withInjectedImage(body: ChatRequestBody, imageDataURL: string): ChatRequestBody {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return body;
  return { ...body, messages: injectImageIntoLastUserMessage(messages, imageDataURL) };
}

function getRagKbInjectLabel(): string {
  const s = (process.env.RAG_KB_INJECT_BLOCK_LABEL || "【知识库检索结果】").trim();
  return s || "【知识库检索结果】";
}

function truncateRagKbInjectBody(text: string): string {
  const maxChars = Math.min(
    200_000,
    Math.max(500, parseInt(process.env.RAG_KB_MAX_INJECT_CHARS || "16000", 10) || 16_000)
  );
  const t = text.trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}\n…(已截断)`;
}

/**
 * 将知识库非流式返回的文本，以独立 `type: text` 段插入最后一条 user 的 content 最前（与图片的 content 数组并列）。
 */
function injectRagKnowledgeIntoLastUserMessage(messages: ChatMessage[], ragText: string): ChatMessage[] {
  const label = getRagKbInjectLabel();
  const body = truncateRagKbInjectBody(ragText);
  if (!body) return messages;

  const ragPart: ContentPart = {
    type: "text",
    text: `${label}\n${body}\n\n---\n`,
  };

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

  let nextContent: ContentPart[] | string;
  if (typeof currentContent === "string") {
    nextContent = [ragPart, { type: "text", text: currentContent }];
  } else if (Array.isArray(currentContent)) {
    const withoutOldRag = currentContent.filter((p) => {
      if (p?.type !== "text" || !p.text) return true;
      return !p.text.trimStart().startsWith(label);
    });
    nextContent = [ragPart, ...withoutOldRag];
  } else {
    nextContent = [ragPart];
  }

  nextMessages[targetIndex] = { ...targetMessage, content: nextContent };
  return nextMessages;
}

/** 从 messages 中取最后一条 user 消息的文本内容（用于入库） */
function getLastUserMessageContent(messages: ChatMessage[]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user") continue;
    const c = messages[i].content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const text = c.map((p) => (p?.type === "text" && p.text ? p.text : "")).filter(Boolean).join("");
      return text;
    }
    return "";
  }
  return "";
}

// ─── Route handlers ───────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  /** 从本接口收到请求开始计时，用于统计到 LLM 首字/完整响应的延迟 */
  const requestT0 = performance.now();
  try {
    // ── 1. 解析请求体 ────────────────────────────────────────────────────────
    const body = (await request.json()) as ChatRequestBody;
    console.log("[chat/completions] requestData:", JSON.stringify(body));

    if (!body.messages || body.messages.length === 0) {
      return NextResponse.json({ error: "Messages are required" }, { status: 400 });
    }

    /** 解析 user / user_id / agent_info.user_id（用于实例映射；知识库另需命中 RAG_KB_ALLOWED_USER_IDS） */
    const userIdForKb = resolveUserId(body);

    // ── 2. 解析 agentInstanceId，获取图片并注入（需求 2、3）───────────────────
    const store = AgentStore.getInstance();

    let agentInstanceId = resolveAgentInstanceId(request, body);
    if (!agentInstanceId) {
      if (userIdForKb) {
        agentInstanceId = store.getAgentInstanceIdByUserId(userIdForKb);
      }
    }

    const imageInstanceIds = store.getImageInstanceIds();
    console.log("[chat/completions] images in memory (instance_ids):", imageInstanceIds.length ? imageInstanceIds : "(none)");
    const imageDataURL = agentInstanceId ? store.getLatestImageDataURL(agentInstanceId) : "";
    console.log("[chat/completions] agent_instance_id:", agentInstanceId || "(none)", "hasImage:", !!imageDataURL);

    /** 日志用：便于按 agent_instance_id / agent_user_id / room_id 筛选 */
    const logContext = {
      agent_instance_id: body.agent_info?.agent_instance_id != null ? String(body.agent_info.agent_instance_id) : agentInstanceId || "",
      agent_user_id: body.agent_info?.agent_user_id != null ? String(body.agent_info.agent_user_id) : "",
      room_id: body.agent_info?.room_id != null ? String(body.agent_info.room_id) : "",
    };

    const payload = imageDataURL ? withInjectedImage(body, imageDataURL) : { ...body };

    // ── 3. 强制替换 system prompt（需求 4），并按实例语言追加「始终用xx语言回答」──
    let systemPrompt =
      (typeof process.env.LLM_PROXY_SYSTEM_PROMPT === "string" && process.env.LLM_PROXY_SYSTEM_PROMPT.trim()) ||
      DEFAULT_SYSTEM_PROMPT;
    const languageName = agentInstanceId ? store.getLanguageForAgentInstance(agentInstanceId) : "";
    if (languageName) {
      systemPrompt = systemPrompt.trimEnd() + "\n主要使用" + languageName + "进行回答，但要根据用户实际对话语言进行匹配；若用户夹杂其他语言或术语，尽量以相同习惯与表达方式回复。";
    }
    systemPrompt =
      systemPrompt.trimEnd() +
      "\n仅输出纯文本最终答案，不要输出任何格式化内容（不要使用 Markdown、代码块、列表、标题、加粗、斜体、表格、HTML/XML 标签）。同时禁止输出任何思维链内容或标签（例如 <think>、</think>）。";
    const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];
    const systemIndex = messages.findIndex((m) => m?.role === "system");
    const systemMessage = { role: "system" as const, content: systemPrompt };
    if (systemIndex >= 0) {
      messages[systemIndex] = systemMessage;
    } else {
      messages.unshift(systemMessage);
    }
    payload.messages = messages;

    // 异步写入 DB：询问内容（不阻塞接口）
    const questionContent = getLastUserMessageContent(payload.messages);
    if (logContext.agent_instance_id || logContext.room_id) {
      insertLlmLog({
        agent_instance_id: logContext.agent_instance_id,
        agent_user_id: logContext.agent_user_id,
        room_id: logContext.room_id,
        type: "question",
        content: questionContent,
      });
    }

    // ── 4. 强制覆盖 model（需求 9）──────────────────────────────────────────
    if (process.env.LLM_PROXY_UPSTREAM_MODEL) {
      payload.model = process.env.LLM_PROXY_UPSTREAM_MODEL;
    }
    const model = payload.model || "";

    // ── 4b. 知识库 RAG：仅当请求中带 user / user_id / agent_info.user_id 且配置了 URL 时启用 ──
    const ragMode = getRagKbMode();
    const ragKbUrl = (process.env.RAG_KB_COMPLETIONS_URL || "").trim();
    const useRagKb = Boolean(
      userIdForKb && ragMode !== "off" && ragKbUrl && isUserIdAllowedForRagKb(userIdForKb)
    );
    const ragToolMode = useRagKb && ragMode === "tool";
    const ragProxyMode = useRagKb && ragMode === "proxy";

    // proxy：先向知识库拉取非流式结果，再注入最后一条 user（多段 text，与图片并列），最后仍走上游 LLM
    if (ragProxyMode) {
      const ragHeaders = getRagKbAuthHeaders();
      const ragMessages = serializeMessagesForRag(payload.messages);
      const reChat = getRagKbReChat();
      console.log("[chat/completions] RAG KB retrieve→inject user_id:", userIdForKb, "url:", ragKbUrl);

      const ragResult = await ragKbChatCompletionAuto({
        url: ragKbUrl,
        headers: ragHeaders,
        messages: ragMessages,
        reChat,
        logLabel: "proxy",
      });

      if (ragResult.ok) {
        const injectedBody = truncateRagKbInjectBody(ragResult.text);
        if (injectedBody) {
          payload.messages = injectRagKnowledgeIntoLastUserMessage(payload.messages as ChatMessage[], ragResult.text);
          const injectLabel = getRagKbInjectLabel();
          const appendSystem =
            process.env.RAG_KB_SYSTEM_HINT_APPEND ??
            "\n用户消息最前的知识库段落，是根据当前用户问题进行的 RAG 检索结果，仅供你参考。请勿盲从或整段照搬；应结合用户真实意图、图片（如有）、常识与人设独立判断后简洁作答；参考与问题无关、过时或明显矛盾时以用户问题与安全合规为准，可忽略参考。";
          if (appendSystem.trim()) {
            const sysIdx = payload.messages.findIndex((m) => m?.role === "system");
            if (sysIdx >= 0) {
              const sm = payload.messages[sysIdx];
              const c = sm.content;
              if (typeof c === "string") {
                payload.messages[sysIdx] = { ...sm, content: c + appendSystem };
              }
            }
          }
          console.log(
            "[chat/completions] RAG KB injected → upstream LLM, blockLabel:",
            injectLabel,
            "injectChars:",
            injectedBody.length,
            "ragKbMs:",
            ragResult.durationMs,
            "ragKbFirstDeltaMs:",
            ragResult.firstDeltaMs ?? "(n/a)"
          );
        }
      } else if (!ragResult.ok) {
        console.warn(
          "[chat/completions] RAG KB retrieve failed, continue without injection, ragKbMs:",
          ragResult.durationMs,
          "status:",
          ragResult.status,
          ragResult.body
        );
      }
    }

    // ── 5. 初始化 OpenAI 客户端（需求 5：不校验 token，直接用环境变量 key）──
    const upstreamAPIKey = process.env.LLM_PROXY_UPSTREAM_API_KEY || "";
    if (!upstreamAPIKey) {
      return NextResponse.json(
        { code: 500, message: "LLM_PROXY_UPSTREAM_API_KEY is required" },
        { status: 500 }
      );
    }

    // LLM_PROXY_UPSTREAM_URL 可以是完整 endpoint（含 /chat/completions），也可以是 base URL
    const upstreamURL = process.env.LLM_PROXY_UPSTREAM_URL || "https://openrouter.ai/api/v1/chat/completions";
    const baseURL = upstreamURL.replace(/\/chat\/completions\/?$/, "");

    const openai = new OpenAI({ apiKey: upstreamAPIKey, baseURL });

    const maxRagToolRounds = Math.min(
      8,
      Math.max(1, parseInt(process.env.RAG_KB_MAX_TOOL_ROUNDS || "4", 10) || 4)
    );

    // 打印发往上游的请求体（base64 图片用占位符，避免刷屏）
    const bodyForLog = (() => {
      const copy = JSON.parse(JSON.stringify(payload)) as ChatRequestBody;
      const ragLabelForLog = getRagKbInjectLabel();
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
              if (
                part?.type === "text" &&
                typeof part.text === "string" &&
                part.text.trimStart().startsWith(ragLabelForLog)
              ) {
                part.text = `[${ragLabelForLog} ${part.text.length} chars]`;
              }
            }
          }
        }
      }
      return copy;
    })();
    console.log("[chat/completions] upstream baseURL:", baseURL);
    if (ragToolMode) {
      console.log("[chat/completions] RAG KB tool mode user_id:", userIdForKb, "rounds<=", maxRagToolRounds);
    }
    console.log("[chat/completions] request body:", JSON.stringify(bodyForLog, null, 2));

    // ── 6. 流式响应：TransformStream 逐 chunk 写入（需求 6）─────────────────
    if (body.stream) {
      const stream = new TransformStream();
      const writer = stream.writable.getWriter();
      const encoder = new TextEncoder();
      let sseEnded = false;

      try {
        if (ragToolMode) {
          const { messages: afterTool } = await runRagKbToolLoop({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            openai: openai as any,
            model,
            messages: payload.messages as unknown[],
            ragUrl: ragKbUrl,
            ragHeaders: getRagKbAuthHeaders(),
            reChat: getRagKbReChat(),
            maxToolRounds: maxRagToolRounds,
          });
          const text = getLastAssistantText(afterTool);
          console.log(
            "[chat/completions] 接口→LLM回答就绪延迟 ms (tool 模式，上游为非流式):",
            (performance.now() - requestT0).toFixed(1),
            JSON.stringify(logContext)
          );
          await writeOpenAiSseStreamFromText(text, writer, encoder, {
            onFirstContentChunk: () => {
              console.log(
                "[chat/completions] 接口→下行 SSE 首包延迟 ms (合成流式分块):",
                (performance.now() - requestT0).toFixed(1),
                JSON.stringify(logContext)
              );
            },
          });
          sseEnded = true;
          if (text) {
            console.log("[chat/completions] LLM+RAG tool output (stream):", JSON.stringify({ ...logContext, content: text }));
            insertLlmLog({
              agent_instance_id: logContext.agent_instance_id,
              agent_user_id: logContext.agent_user_id,
              room_id: logContext.room_id,
              type: "answer",
              content: text,
            });
          }
        } else {
          const completion = await openai.chat.completions.create({
            model,
            stream: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            messages: payload.messages as any,
          });

          let llmOutputAcc = "";
          let loggedFirstLlmToken = false;
          // 注意⚠️：AIAgent 要求最后一个有效数据必须包含 "finish_reason":"stop"，
          // 且最后必须发送 data: [DONE]，否则可能导致智能体不回答或回答不完整。
          for await (const chunk of completion) {
            const content = (chunk as any).choices?.[0]?.delta?.content;
            if (typeof content === "string" && content.length > 0 && !loggedFirstLlmToken) {
              loggedFirstLlmToken = true;
              console.log(
                "[chat/completions] 接口→LLM首字延迟 ms (流式):",
                (performance.now() - requestT0).toFixed(1),
                JSON.stringify(logContext)
              );
            }
            if (typeof content === "string") llmOutputAcc += content;
            const ssePart = `data: ${JSON.stringify(chunk)}\n\n`;
            writer.write(encoder.encode(ssePart));
          }
          if (llmOutputAcc) {
            console.log("[chat/completions] LLM output (stream):", JSON.stringify({ ...logContext, content: llmOutputAcc }));
            insertLlmLog({
              agent_instance_id: logContext.agent_instance_id,
              agent_user_id: logContext.agent_user_id,
              room_id: logContext.room_id,
              type: "answer",
              content: llmOutputAcc,
            });
          }
        }
      } catch (error) {
        console.error("[chat/completions] stream processing error:", error);
      } finally {
        if (!sseEnded) {
          writer.write(encoder.encode("data: [DONE]\n\n"));
        }
        writer.close();
        console.log("[chat/completions] writer closed");
      }

      return new Response(stream.readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // ── 7. 非流式响应：透传上游内容（需求 7）────────────────────────────────
    if (ragToolMode) {
      const { messages: afterTool } = await runRagKbToolLoop({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        openai: openai as any,
        model,
        messages: payload.messages as unknown[],
        ragUrl: ragKbUrl,
        ragHeaders: getRagKbAuthHeaders(),
        reChat: getRagKbReChat(),
        maxToolRounds: maxRagToolRounds,
      });
      const text = getLastAssistantText(afterTool);
      console.log(
        "[chat/completions] 接口→LLM回答就绪延迟 ms (tool+非流式):",
        (performance.now() - requestT0).toFixed(1),
        JSON.stringify(logContext)
      );
      if (text) {
        console.log("[chat/completions] LLM+RAG tool output:", JSON.stringify({ ...logContext, content: text }));
        insertLlmLog({
          agent_instance_id: logContext.agent_instance_id,
          agent_user_id: logContext.agent_user_id,
          room_id: logContext.room_id,
          type: "answer",
          content: text,
        });
      }
      return NextResponse.json(buildOpenAiNonStreamCompletionJson(model, text));
    }

    const completion = await openai.chat.completions.create({
      model,
      stream: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: payload.messages as any,
    });
    console.log(
      "[chat/completions] 接口→LLM完整响应延迟 ms (非流式，无首字概念):",
      (performance.now() - requestT0).toFixed(1),
      JSON.stringify(logContext)
    );
    const llmOutput = (completion as any).choices?.[0]?.message?.content;
    if (llmOutput != null) {
      console.log("[chat/completions] LLM output:", JSON.stringify({ ...logContext, content: llmOutput }));
      insertLlmLog({
        agent_instance_id: logContext.agent_instance_id,
        agent_user_id: logContext.agent_user_id,
        room_id: logContext.room_id,
        type: "answer",
        content: llmOutput,
      });
    }
    return NextResponse.json(completion);
  } catch (error) {
    console.error("[chat/completions] llm proxy failed:", error);
    return NextResponse.json(
      { code: 500, message: (error as Error).message || "llm proxy failed" },
      { status: 500 }
    );
  }
}

// CORS 预检
export async function OPTIONS() {
  return NextResponse.json(
    {},
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    }
  );
}
