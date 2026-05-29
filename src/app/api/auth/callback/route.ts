import { NextRequest, NextResponse } from "next/server";
import { exchangeCode } from "@/lib/spotify";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.json({ error: "Missing code" }, { status: 400 });
  }

  try {
    const tokens = await exchangeCode(code);
    // Pass tokens to the frontend via URL fragment (kept client-side only)
    const params = new URLSearchParams({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? "",
      expires_in: String(tokens.expires_in),
    });
    const host = req.headers.get("host") ?? "127.0.0.1:3000";
    const proto = req.headers.get("x-forwarded-proto") ?? "http";
    return NextResponse.redirect(
      new URL(`/?${params.toString()}`, `${proto}://${host}`)
    );
  } catch (err) {
    console.error("OAuth callback error:", err);
    return NextResponse.json(
      { error: "Token exchange failed" },
      { status: 500 }
    );
  }
}
