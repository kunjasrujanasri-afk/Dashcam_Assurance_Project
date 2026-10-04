import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function retired() {
  return NextResponse.json({ error: "This public legacy endpoint has been retired. Sign in to use workspace-scoped signed evidence." }, { status: 410 });
}

export async function GET() { return retired(); }
export async function POST() { return retired(); }
