import { NextRequest } from "next/server";
import { ZegoAIAgent, CONSTANTS, AdvancedConfig, LLMConfig, TTSConfig, ASRConfig, MessageHistory, CallbackConfig } from "@/lib/zego/aiagent";
import { AgentStore } from "@/lib/store";
import { parseJSON } from "@/lib/json";

// 定义请求体类型
interface RequestBody {
  agent_id: string;
  agent_name: string;
}

// 这里只是作为最简单的示例。所以以下参数都是固定的。请根据您实际的场景进行动态设置。
function randomId(prefix: string) {
  return prefix + Math.random().toString(36).substring(2, 10);
}

/** 请求头 Lang 到 ASR 引擎（16k_xx）的映射 */
const LANG_TO_ASR_ENGINE: Record<string, string> = {
  "ko-kr": "16k_ko",
  "en-ww": "16k_en",
  "zh-cn": "16k_zh",
  "zh-hk": "16k_zh",
  "ru-ru": "16k_en",   // 俄语无直接引擎，暂用英文
  "id-id": "16k_id",
  "ja-jp": "16k_ja",
  "th-th": "16k_th",
  "pt-pt": "16k_pt",
  "sr-sr": "16k_en",   // 塞尔维亚语无直接引擎，暂用英文
  "es-es": "16k_es",
  "nan-cha": "16k_zh", // 闽南/潮汕，暂用中文
  "zh-mars": "16k_zh",
  "ar-kw": "16k_ar",
  "vi-vn": "16k_vi",
  "tr-tk": "16k_tr",
  "sq-sq": "16k_en",   // 阿尔巴尼亚语无直接引擎，暂用英文
};

function langToAsrEngine(lang: string): string | undefined {
  const normalized = lang.toLowerCase().trim();
  return LANG_TO_ASR_ENGINE[normalized];
}

/**
 * engine_model_type（16k_xx）到 TTS explicit_language 的映射
 * 文档支持：zh-cn / en / ja / es-mx / id / pt-br / de / fr；无对应项则不设置
 */
const ENGINE_MODEL_TYPE_TO_EXPLICIT_LANGUAGE: Record<string, string> = {
  "16k_zh": "zh-cn",
  "16k_zh-PY": "zh-cn",
  "16k_zh-TW": "zh-cn",
  "16k_zh_edu": "zh-cn",
  "16k_zh_medical": "zh-cn",
  "16k_zh_court": "zh-cn",
  "16k_yue": "zh-cn",
  "16k_zh_en": "zh-cn",
  "16k_en": "en",
  "16k_en_game": "en",
  "16k_en_edu": "en",
  "16k_ja": "ja",
  "16k_es": "es-mx",
  "16k_id": "id",
  "16k_pt": "pt-br",
  "16k_de": "de",
  "16k_fr": "fr",
  // 以下引擎文档暂无对应 explicit_language，不映射
  // 16k_ko, 16k_th, 16k_vi, 16k_ar, 16k_tr, 16k_ms, 16k_fil, 16k_hi
};

function engineToExplicitLanguage(engineModelType: string): string | undefined {
  return ENGINE_MODEL_TYPE_TO_EXPLICIT_LANGUAGE[engineModelType];
}

/** 中英文使用该 voice_type */
const TTS_VOICE_TYPE_ZH_EN = "zh_female_wanwanxiaohe_moon_bigtts";
/** 日语、西语使用该 voice_type */
const TTS_VOICE_TYPE_JA_ES = "multi_female_shuangkuaisisi_moon_bigtts";
/** 无对应配置时的默认 voice_type */
const TTS_VOICE_TYPE_DEFAULT = "zh_female_vv_uranus_bigtts";

/** 不在 ENGINE_MODEL_TYPE_TO_VOICE_TYPE 中的 engine_model_type 均使用 Minimax TTS */
function useMinimaxTTS(engineModelType: string): boolean {
  return !(engineModelType in ENGINE_MODEL_TYPE_TO_VOICE_TYPE);
}

/** engine_model_type（16k_xx）到 TTS voice_type 的映射（仅 ByteDance 使用；未在此表中的走 Minimax） */
const ENGINE_MODEL_TYPE_TO_VOICE_TYPE: Record<string, string> = {
  "16k_zh": TTS_VOICE_TYPE_ZH_EN,
  "16k_zh-PY": TTS_VOICE_TYPE_ZH_EN,
  "16k_zh-TW": TTS_VOICE_TYPE_ZH_EN,
  "16k_zh_edu": TTS_VOICE_TYPE_ZH_EN,
  "16k_zh_medical": TTS_VOICE_TYPE_ZH_EN,
  "16k_zh_court": TTS_VOICE_TYPE_ZH_EN,
  "16k_yue": TTS_VOICE_TYPE_ZH_EN,
  "16k_zh_en": TTS_VOICE_TYPE_ZH_EN,
  "16k_en": TTS_VOICE_TYPE_ZH_EN,
  "16k_en_game": TTS_VOICE_TYPE_ZH_EN,
  "16k_en_edu": TTS_VOICE_TYPE_ZH_EN,
  "16k_ja": TTS_VOICE_TYPE_JA_ES,
  "16k_es": TTS_VOICE_TYPE_JA_ES,
};

function engineToVoiceType(engineModelType: string): string {
  return ENGINE_MODEL_TYPE_TO_VOICE_TYPE[engineModelType] ?? TTS_VOICE_TYPE_DEFAULT;
}

/** engine_model_type（16k_xx）到中文语言名的映射，用于 prompt 末尾「始终用xx语言回答」 */
const ASR_ENGINE_TO_LANGUAGE_CN: Record<string, string> = {
  "16k_zh": "中文",
  "16k_zh-PY": "中文",
  "16k_zh-TW": "中文繁体",
  "16k_zh_edu": "中文",
  "16k_zh_medical": "中文",
  "16k_zh_court": "中文",
  "16k_yue": "粤语",
  "16k_en": "英语",
  "16k_en_game": "英语",
  "16k_en_edu": "英语",
  "16k_zh_en": "中文",
  "16k_ko": "韩语",
  "16k_ja": "日语",
  "16k_th": "泰语",
  "16k_id": "印度尼西亚语",
  "16k_vi": "越南语",
  "16k_ms": "马来语",
  "16k_fil": "菲律宾语",
  "16k_pt": "葡萄牙语",
  "16k_tr": "土耳其语",
  "16k_ar": "阿拉伯语",
  "16k_es": "西班牙语",
  "16k_hi": "印地语",
  "16k_fr": "法语",
  "16k_de": "德语",
};

export async function POST(req: NextRequest) {
  try {
    // 打印请求头
    const headers = Object.fromEntries(req.headers.entries());
    console.log("request headers:", headers);

    // 从请求头获取 Lang 参数（header 名称大小写不敏感）
    const lang = req.headers.get("lang") ?? undefined;
    const asrEngine = lang ? langToAsrEngine(lang) : undefined;

    const assistant = ZegoAIAgent.getInstance();

    // 确保智能体已注册
    await assistant.ensureAgentRegistered(CONSTANTS.AGENT_ID, CONSTANTS.AGENT_NAME);

    // 保存 agent_instance_id
    const store = AgentStore.getInstance();
    const existingInstanceId = store.getAgentInstanceId();
    if (existingInstanceId) {
      await assistant.deleteAgentInstance(existingInstanceId);
      store.unbindUserByAgentInstanceId(existingInstanceId);
      store.clearLatestImage(existingInstanceId);
      store.clearLanguageForAgentInstance(existingInstanceId);
      store.setAgentInstanceId("");
    }
    const body = await req.json();
    const user_id = body.user_id;
    const room_id = body.room_id;
    const agent_stream_id = randomId("stream_agent_");
    const agent_user_id = randomId("user_agent_");
    const user_stream_id = body.user_stream_id;
    const llmConfig: LLMConfig | null = null;
    const explicitLanguage = asrEngine ? engineToExplicitLanguage(asrEngine) : undefined;
    const ttsVoice = asrEngine ? engineToVoiceType(asrEngine) : "";
    let ttsVendor: string | undefined;
    let ttsVoiceUsed = ttsVoice;
    const ttsConfig: TTSConfig | null = (() => {
      if (asrEngine && useMinimaxTTS(asrEngine)) {
        const apiKey = process.env.TTS_MINIMAX_API_KEY ?? "zego_test";
        const groupId = process.env.TTS_MINIMAX_GROUP_ID;
        const model = process.env.TTS_MINIMAX_MODEL ?? "speech-02-turbo-preview";
        const voiceId = process.env.TTS_MINIMAX_VOICE_ID ?? "female-shaonv";
        ttsVendor = "Minimax";
        ttsVoiceUsed = voiceId;
        const app: Record<string, string> = { api_key: apiKey };
        if (groupId) app.group_id = groupId;
        return {
          Vendor: "Minimax",
          Params: {
            app,
            model,
            voice_setting: { voice_id: voiceId },
          },
        };
      }
      if (explicitLanguage != null) {
        const defaultTTS = assistant.getDefaultTTSConfig();
        const defaultAudio = (defaultTTS.Params as any)?.audio ?? {};
        return {
          ...defaultTTS,
          Params: {
            ...defaultTTS.Params,
            audio: {
              ...defaultAudio,
              voice_type: ttsVoice,
              explicit_language: explicitLanguage,
            },
          },
        };
      }
      return null;
    })();
    const asrConfig: ASRConfig | null =
      asrEngine != null
        ? {
            Vendor: "Tencent",
            Params: { engine_model_type: asrEngine },
          }
        : null;
    const messageHistory: MessageHistory | null = null;
    const callbackConfig: CallbackConfig | null = null;
    const advancedConfig: AdvancedConfig | null = process.env.ADVANCED_CONFIG ? parseJSON(process.env.ADVANCED_CONFIG) : null;

    console.log("ASR config:", JSON.stringify(asrConfig, null, 2));
    console.log("TTS config:", JSON.stringify(ttsConfig, null, 2));

    const result = await assistant.createAgentInstance(CONSTANTS.AGENT_ID, user_id, {
      RoomId: room_id,
      AgentStreamId: agent_stream_id,
      AgentUserId: agent_user_id,
      UserStreamId: user_stream_id,
    }, llmConfig, ttsConfig, asrConfig, messageHistory, callbackConfig, advancedConfig);
    const agent_instance_id = result.Data.AgentInstanceId;
    console.log("create agent instance", agent_instance_id);
    store.setAgentInstanceId(agent_instance_id);
    store.bindUserToAgentInstance(user_id, agent_instance_id);
    if (asrEngine) {
      const languageName = ASR_ENGINE_TO_LANGUAGE_CN[asrEngine] ?? "英语";
      store.setLanguageForAgentInstance(agent_instance_id, languageName);
    }

    return Response.json(
      {
        code: 0,
        message: "start agent success",
        agent_id: CONSTANTS.AGENT_ID,
        agent_name: CONSTANTS.AGENT_NAME,
        agent_instance_id: agent_instance_id,
        agent_stream_id: agent_stream_id,
        agent_user_id: agent_user_id,
        ...(lang !== undefined && { lang }),
        ...(asrEngine !== undefined && { asr_engine: asrEngine }),
        ...(explicitLanguage !== undefined && { explicit_language: explicitLanguage }),
        ...(ttsVendor !== undefined && { tts_vendor: ttsVendor }),
        ...(ttsVoiceUsed !== undefined && ttsVoiceUsed !== "" && { tts_voice: ttsVoiceUsed }),
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("register agent failed:", error);
    return Response.json(
      {
        code: (error as any).code || 500,
        message:
          (error as any).message || "start agent failed with unknown error",
      },
      { status: 500 }
    );
  }
}
