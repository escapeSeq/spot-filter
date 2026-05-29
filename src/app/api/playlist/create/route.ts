import { NextRequest, NextResponse } from "next/server";
import { createPlaylist } from "@/lib/spotify";

export async function POST(req: NextRequest) {
  const accessToken = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name, description, public: isPublic, collaborative, tracks } = body;

    if (!name || !Array.isArray(tracks)) {
      return NextResponse.json(
        { error: "name and tracks[] are required" },
        { status: 400 }
      );
    }

    const trackUris: string[] = tracks.map(
      (t: { uri: string }) => t.uri
    );

    const result = await createPlaylist(accessToken, {
      name,
      description: description ?? "",
      public: isPublic ?? false,
      collaborative: collaborative ?? false,
      trackUris,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error("Playlist create error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
