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

export async function POST(req: NextRequest) {
  try {
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
      store.setAgentInstanceId("");
    }
    const body = await req.json();
    const user_id = body.user_id;
    const room_id = body.room_id;
    const agent_stream_id = randomId("stream_agent_");
    const agent_user_id = randomId("user_agent_");
    const user_stream_id = body.user_stream_id;
    const llmConfig: LLMConfig | null = null;
    const ttsConfig: TTSConfig | null = null;
    const asrConfig: ASRConfig | null = null;
    const messageHistory: MessageHistory | null = null;
    const callbackConfig: CallbackConfig | null = null;
    const advancedConfig: AdvancedConfig | null = process.env.ADVANCED_CONFIG ? parseJSON(process.env.ADVANCED_CONFIG) : null;

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

    return Response.json(
      {
        code: 0,
        message: "start agent success",
        agent_id: CONSTANTS.AGENT_ID,
        agent_name: CONSTANTS.AGENT_NAME,
        agent_instance_id: agent_instance_id,
        agent_stream_id: agent_stream_id,
        agent_user_id: agent_user_id,
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
