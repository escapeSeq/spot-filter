import { NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/spotify";
import crypto from "crypto";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = crypto.randomBytes(16).toString("hex");
  const url = getAuthUrl(state);
  return NextResponse.redirect(url);
}
