import { NextRequest, NextResponse } from "next/server";
import { getUploadedImageById } from "@/lib/db";

/**
 * 按 id 返回数据库中保存的图片（query：id）
 */
export async function GET(request: NextRequest) {
  try {
    const idRaw = request.nextUrl.searchParams.get("id");
    const id = idRaw ? parseInt(idRaw, 10) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json(
        { code: 400, message: "query id is required and must be a positive integer" },
        { status: 400 }
      );
    }

    const row = await getUploadedImageById(id);
    if (!row) {
      return NextResponse.json(
        { code: 404, message: "image not found" },
        { status: 404 }
      );
    }

    return new NextResponse(new Uint8Array(row.image_data), {
      status: 200,
      headers: {
        "Content-Type": row.mime_type || "application/octet-stream",
        "Content-Length": String(row.image_data.length),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    console.error("get upload image failed:", error);
    return NextResponse.json(
      {
        code: 500,
        message: (error as Error).message || "get image failed",
      },
      { status: 500 }
    );
  }
}
