import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Host bootstrap only: not part of the companion's public backend contract.
export async function GET() {
  const port = Number(process.env.ST_COMPANION_PORT);
  const token = process.env.ST_COMPANION_TOKEN ?? "";
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[0-9a-f]{64}$/.test(token)) {
    return NextResponse.json({ error: "No managed companion is running." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ baseUrl: `http://127.0.0.1:${port}`, token }, { headers: { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" } });
}
