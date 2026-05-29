import { NextRequest, NextResponse } from "next/server";
import { getPlaylist } from "@/lib/spotify";

export async function GET(req: NextRequest) {
  const accessToken = req.headers.get("authorization")?.replace("Bearer ", "");
  const playlistId = req.nextUrl.searchParams.get("id");

  if (!accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!playlistId) {
    return NextResponse.json(
      { error: "Missing playlist id" },
      { status: 400 }
    );
  }

  try {
    const data = await getPlaylist(playlistId, accessToken);
    return NextResponse.json(data);
  } catch (err) {
    console.error("Playlist fetch error:", err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}
