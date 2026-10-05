import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_KEY;
  let secret = key?.startsWith("sb_secret_");
  if (key?.split(".").length === 3) {
    try { secret = secret || JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString()).role === "service_role"; }
    catch { return res.status(503).json({ configured: false }); }
  }
  if (!url || !key || secret) return res.status(503).json({ configured: false });
  return res.json({ configured: true, url, key });
}
