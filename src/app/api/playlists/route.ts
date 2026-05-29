import { NextRequest, NextResponse } from "next/server";
import { getUserPlaylists } from "@/lib/spotify";

export async function GET(req: NextRequest) {
  const accessToken = req.headers.get("authorization")?.replace("Bearer ", "");

  if (!accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const playlists = await getUserPlaylists(accessToken);
    return NextResponse.json({ playlists });
  } catch (err) {
    console.error("Playlists fetch error:", err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}
