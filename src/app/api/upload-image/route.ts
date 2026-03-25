import { NextRequest, NextResponse } from "next/server";
import { AgentStore } from "@/lib/store";
import { insertUploadedImage } from "@/lib/db";

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

function parseAgentInstanceId(formData: FormData): string {
  const value = formData.get("agent_instance_id") ?? formData.get("id");
  return typeof value === "string" ? value.trim() : "";
}

/** 上传接口返回的 image_url 所用公网 origin（可被环境变量覆盖） */
const DEFAULT_IMAGE_URL_ORIGIN =
  "https://nonexceptional-brigette-comfortingly.ngrok-free.dev";

function resolveImageUrlOrigin(): string {
  const base =
    process.env.PUBLIC_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    DEFAULT_IMAGE_URL_ORIGIN;
  return base.replace(/\/$/, "");
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
    const buffer = Buffer.from(bytes);
    const base64 = buffer.toString("base64");
    const imageDataURL = `data:${file.type};base64,${base64}`;

    const imageId = await insertUploadedImage({
      agent_instance_id: agentInstanceId,
      file_name: file.name,
      mime_type: file.type,
      file_size: file.size,
      image_buffer: buffer,
    });

    if (imageId == null) {
      return NextResponse.json(
        {
          code: 503,
          message:
            "failed to persist image: check DB_HOST / DB_USER / DB_PASSWORD / DB_DATABASE (use szb02 for uploaded images)",
        },
        { status: 503 }
      );
    }

    const store = AgentStore.getInstance();
    store.setLatestImageDataURL(agentInstanceId, imageDataURL);

    const origin = resolveImageUrlOrigin();
    const imageUrl = `${origin}/api/get_upload_image?id=${imageId}`;

    return NextResponse.json({
      code: 0,
      message: "upload image success",
      agent_instance_id: agentInstanceId,
      image_id: imageId,
      image_url: imageUrl,
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
