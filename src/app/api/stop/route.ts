import { NextRequest } from "next/server";
import { ZegoAIAgent } from "@/lib/zego/aiagent";
import { AgentStore } from "@/lib/store";

// 定义请求体类型 / Define request body type
interface RequestBody {
  agent_instance_id?: string;
}

export async function POST(req: NextRequest) {
  try {
    console.log("stop agent instance");
    // 尝试从请求体获取 agent_instance_id / Try to get agent_instance_id from request body
    let agent_instance_id: string = "";

    try {
      const body: RequestBody = await req.json();
      agent_instance_id = body.agent_instance_id || "";
    } catch (e) {
      // 如果解析请求体失败，忽略错误 / If parsing request body fails, ignore error
      console.log(
        "No request body or invalid JSON, will use stored instance ID"
      );
    }

    const store = AgentStore.getInstance();
    if (!agent_instance_id) {
      agent_instance_id = store.getAgentInstanceId();
    }

    if (!agent_instance_id) {
      return Response.json(
        {
          code: 404,
          message:
            "agent instance not found - no instance ID provided and no stored instance",
        },
        { status: 404 }
      );
    }

    console.log("delete agent instance:", agent_instance_id);

    const assistant = ZegoAIAgent.getInstance();
    await assistant.deleteAgentInstance(agent_instance_id);
    store.unbindUserByAgentInstanceId(agent_instance_id);
    store.clearLatestImage(agent_instance_id);
    if (store.getAgentInstanceId() === agent_instance_id) {
      store.setAgentInstanceId("");
    }

    return Response.json(
      {
        code: 0,
        message: "delete agent instance success",
        agent_instance_id: agent_instance_id,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("delete agent instance failed:", error);
    return Response.json(
      {
        code: (error as any).code || 500,
        message: `delete agent instance failed: ${
          (error as any).message || "unknown error"
        }`,
      },
      { status: 500 }
    );
  }
}
