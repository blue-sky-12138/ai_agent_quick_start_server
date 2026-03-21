/**
 * RAG 知识库：按 RAG_KB_MODE 支持
 * - proxy：先请求知识库 Chat Completions（非流式）取检索文本，注入最后一条 user 的 content（与多模态多段 text 并列），再请求上游 LLM
 * - tool：仍走上游 LLM，通过 function calling 调用知识库接口拉取片段再回答
 */

export type RagKbMode = "off" | "proxy" | "tool";

export function getRagKbMode(): RagKbMode {
  const raw = (process.env.RAG_KB_MODE || "off").trim().toLowerCase();
  if (raw === "proxy" || raw === "direct" || raw === "llm") return "proxy";
  if (raw === "tool") return "tool";
  return "off";
}

export function getRagKbAuthHeaders(): Record<string, string> {
  const apiKey = (process.env.RAG_KB_API_KEY || "").trim();
  const csrf = (process.env.RAG_KB_CSRF_TOKEN || "").trim();
  const headers: Record<string, string> = {
    accept: "*/*",
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (csrf) headers["X-CSRFTOKEN"] = csrf;
  return headers;
}

export function getRagKbReChat(): boolean {
  return (process.env.RAG_KB_RE_CHAT || "").trim().toLowerCase() === "true";
}

/**
 * 仅当 user_id 在白名单内才启用知识库。RAG_KB_ALLOWED_USER_IDS 为逗号分隔（支持英文/中文逗号），未配置或为空则一律不启用。
 */
export function isUserIdAllowedForRagKb(userId: string): boolean {
  const id = userId.trim();
  if (!id) return false;
  const raw = (process.env.RAG_KB_ALLOWED_USER_IDS || "").trim();
  if (!raw) return false;
  const allowed = raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(id);
}

/** 将上游 OpenAI 风格 messages 序列化为可 JSON 化的结构（知识库侧通常仅需 role + content） */
export function serializeMessagesForRag(messages: unknown[]): unknown[] {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    const msg = m as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "user";
    return { role, content: msg.content };
  });
}

function parseNonStreamRagContent(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  const choices = d.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0] as Record<string, unknown>;
  const msg = first.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (typeof content === "string") return content;
  return "";
}

function getRagKbLogMaxChars(): number {
  return Math.min(100_000, Math.max(200, parseInt(process.env.RAG_KB_LOG_MAX_CHARS || "8000", 10) || 8000));
}

function isRagKbVerboseLog(): boolean {
  return (process.env.RAG_KB_LOG || "verbose").trim().toLowerCase() !== "false";
}

function logRagKbOutcome(params: {
  label: string;
  durationMs: number;
  ok: boolean;
  text?: string;
  status?: number;
  errorBody?: string;
}): void {
  const verbose = isRagKbVerboseLog();
  const maxChars = getRagKbLogMaxChars();
  if (params.ok && params.text != null) {
    const full = params.text;
    if (!verbose) {
      console.log(
        `[rag-kb] ${params.label} ok durationMs=${params.durationMs.toFixed(1)} textChars=${full.length} (set RAG_KB_LOG=verbose for full text)`
      );
      return;
    }
    const printed = full.length > maxChars ? `${full.slice(0, maxChars)}…(全文共 ${full.length} 字)` : full;
    console.log(
      `[rag-kb] ${params.label} ok durationMs=${params.durationMs.toFixed(1)} text:\n${printed}`
    );
  } else {
    console.log(
      `[rag-kb] ${params.label} fail durationMs=${params.durationMs.toFixed(1)} status=${params.status} body:`,
      (params.errorBody || "").slice(0, 2000)
    );
  }
}

/** 非流式：向知识库 Chat Completions 发单轮/多轮，返回助手文本 */
export async function ragKbChatCompletion(params: {
  url: string;
  headers: Record<string, string>;
  messages: unknown[];
  reChat: boolean;
  /** 日志前缀，如 proxy / tool */
  logLabel?: string;
}): Promise<{ ok: true; text: string; durationMs: number } | { ok: false; status: number; body: string; durationMs: number }> {
  const label = params.logLabel || "rag-kb";
  const t0 = performance.now();

  const res = await fetch(params.url, {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify({
      messages: serializeMessagesForRag(params.messages),
      re_chat: params.reChat,
      stream: false,
    }),
  });
  const raw = await res.text();
  const durationMs = performance.now() - t0;

  if (!res.ok) {
    logRagKbOutcome({ label, durationMs, ok: false, status: res.status, errorBody: raw });
    return { ok: false, status: res.status, body: raw.slice(0, 2000), durationMs };
  }
  try {
    const json = JSON.parse(raw) as unknown;
    const text = parseNonStreamRagContent(json);
    const out = text || raw.slice(0, 8000);
    logRagKbOutcome({ label, durationMs, ok: true, text: out });
    return { ok: true, text: out, durationMs };
  } catch {
    const out = raw.slice(0, 8000);
    logRagKbOutcome({ label, durationMs, ok: true, text: out });
    return { ok: true, text: out, durationMs };
  }
}

const KB_TOOL = {
  type: "function" as const,
  function: {
    name: "query_knowledge_base",
    description:
      "从企业知识库检索与用户问题相关的资料。涉及政策、规则、产品说明、操作步骤等问题时应调用；用简短查询词检索。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "用于知识库检索的简短查询" },
      },
      required: ["query"],
    },
  },
};

type OpenAICompat = {
  chat: {
    completions: {
      create: (args: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

type ToolCall = { id: string; function?: { name?: string; arguments?: string } };

function getMessageToolCalls(msg: Record<string, unknown>): ToolCall[] {
  const raw = msg.tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw as ToolCall[];
}

function parseToolArgs(args: string | undefined): { query?: string } {
  if (!args || !args.trim()) return {};
  try {
    return JSON.parse(args) as { query?: string };
  } catch {
    return {};
  }
}

/**
 * tool 模式：循环处理 tool_calls；若模型直接回复（无 tool_calls）则立刻得到最终 assistant message。
 * 超过 maxToolRounds 仍持续要工具时，再发起一次不带 tools 的 completion 收尾。
 */
export async function runRagKbToolLoop(params: {
  openai: OpenAICompat;
  model: string;
  messages: unknown[];
  ragUrl: string;
  ragHeaders: Record<string, string>;
  reChat: boolean;
  maxToolRounds: number;
}): Promise<{ messages: unknown[] }> {
  let messages = [...params.messages];

  for (let i = 0; i < params.maxToolRounds; i += 1) {
    const completion = (await params.openai.chat.completions.create({
      model: params.model,
      stream: false,
      messages,
      tools: [KB_TOOL],
      tool_choice: "auto",
    })) as Record<string, unknown>;

    const choice = (completion.choices as Record<string, unknown>[] | undefined)?.[0];
    const msg = choice?.message as Record<string, unknown> | undefined;
    if (!msg) break;

    const toolCalls = getMessageToolCalls(msg);
    if (toolCalls.length === 0) {
      return { messages: [...messages, msg] };
    }

    messages.push(msg);
    for (const tc of toolCalls) {
      const name = tc.function?.name || "";
      let toolText = "";
      if (name === "query_knowledge_base") {
        const { query } = parseToolArgs(tc.function?.arguments);
        const q = (query || "").trim() || "用户问题";
        const ragResult = await ragKbChatCompletion({
          url: params.ragUrl,
          headers: params.ragHeaders,
          messages: [{ role: "user", content: q }],
          reChat: params.reChat,
          logLabel: "tool",
        });
        toolText = ragResult.ok ? ragResult.text : `知识库请求失败: ${ragResult.status} ${ragResult.body}`;
      } else {
        toolText = `未知工具: ${name}`;
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: toolText,
      });
    }
  }

  const completion = (await params.openai.chat.completions.create({
    model: params.model,
    stream: false,
    messages,
  })) as Record<string, unknown>;

  const choice = (completion.choices as Record<string, unknown>[] | undefined)?.[0];
  const msg = choice?.message as Record<string, unknown> | undefined;
  if (msg) {
    return { messages: [...messages, msg] };
  }
  return { messages };
}

/** 从一轮 tool 循环结束后的 messages 中取最后一条 assistant 的文本 */
export function getLastAssistantText(messages: unknown[]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (m?.role !== "assistant") continue;
    const c = m.content;
    if (typeof c === "string") return c;
  }
  return "";
}

export function buildOpenAiNonStreamCompletionJson(model: string, content: string): Record<string, unknown> {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
}

const STREAM_CHUNK_SIZE = 32;

/** 将整段文本伪装成上游 OpenAI 流式 chunk（兼容现有 ZEGO 解析逻辑） */
export async function writeOpenAiSseStreamFromText(
  text: string,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder
): Promise<void> {
  const id = `chatcmpl-${Date.now()}`;
  for (let i = 0; i < text.length; i += STREAM_CHUNK_SIZE) {
    const piece = text.slice(i, i + STREAM_CHUNK_SIZE);
    const chunk = {
      id,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    };
    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  }
  const end = {
    id,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  await writer.write(encoder.encode(`data: ${JSON.stringify(end)}\n\n`));
  await writer.write(encoder.encode("data: [DONE]\n\n"));
}

export { KB_TOOL };
