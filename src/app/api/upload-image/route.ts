import { NextRequest, NextResponse } from "next/server";
import { AgentStore } from "@/lib/store";

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

function parseAgentInstanceId(formData: FormData): string {
  const value = formData.get("agent_instance_id") ?? formData.get("id");
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        {
          code: 400,
          message: "content-type must be multipart/form-data",
        },
        { status: 400 }
      );
    }

    const formData = await request.formData();
    const agentInstanceId = parseAgentInstanceId(formData);
    const file = formData.get("image");

    if (!agentInstanceId) {
      return NextResponse.json(
        {
          code: 400,
          message: "agent_instance_id is required",
        },
        { status: 400 }
      );
    }

    if (!(file instanceof File)) {
      return NextResponse.json(
        {
          code: 400,
          message: "file is required",
        },
        { status: 400 }
      );
    }

    if (!file.type.startsWith("image/")) {
      return NextResponse.json(
        {
          code: 400,
          message: "only image files are supported",
        },
        { status: 400 }
      );
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      return NextResponse.json(
        {
          code: 400,
          message: `image is too large, max size is ${MAX_IMAGE_SIZE_BYTES} bytes`,
        },
        { status: 400 }
      );
    }

    const bytes = await file.arrayBuffer();
    const base64 = Buffer.from(bytes).toString("base64");
    const imageDataURL = `data:${file.type};base64,${base64}`;

    const store = AgentStore.getInstance();
    store.setLatestImageDataURL(agentInstanceId, imageDataURL);

    return NextResponse.json({
      code: 0,
      message: "upload image success",
      agent_instance_id: agentInstanceId,
      file_name: file.name,
      file_type: file.type,
      file_size: file.size,
    });
  } catch (error) {
    console.error("upload image failed:", error);
    return NextResponse.json(
      {
        code: 500,
        message: (error as Error).message || "upload image failed",
      },
      { status: 500 }
    );
  }
}
