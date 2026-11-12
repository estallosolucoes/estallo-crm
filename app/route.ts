import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

/**
 * A página inicial pública: a landing da Estallo (`public/landing.html`),
 * servida inteira, sem o layout do app. Quem tem sessão confirmada pelo
 * servidor (`getUser()`, nunca `getSession()`) segue direto para o painel.
 * A landing leva a `/login`, `/legal/privacy` e `/legal/terms` — o revisor da
 * verificação do Google abre `/` sem entrar e precisa achar a política.
 */
export const dynamic = "force-dynamic";

// ponytail: lido a cada request (77 KB, cache do SO); cachear em memória se aparecer no perfil
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Location relativo: atrás do Traefik, request.url é o endereço interno do
  // container (http://0.0.0.0:3000), e um redirect absoluto mandaria o
  // navegador para lá.
  if (user) return new NextResponse(null, { status: 307, headers: { location: "/app" } });

  const html = await readFile(path.join(process.cwd(), "public", "landing.html"), "utf8");
  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
