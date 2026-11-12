import type { MetadataRoute } from "next";

import { marcaDaSaida } from "@/lib/branding/saida";

// A imagem distribuída é construída sem a marca da instalação. Uma função
// async, sozinha, ainda pode ser prerenderizada com o nome de fallback do build.
export const dynamic = "force-dynamic";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const marca = await marcaDaSaida(null);
  return {
    name: marca.nome,
    short_name: marca.nome,
    display: "standalone",
    start_url: "/app",
    scope: "/",
    icons: [
      { src: `/app-icon/192`, sizes: "192x192", type: "image/png" },
      { src: `/app-icon/512`, sizes: "512x512", type: "image/png" },
    ],
  };
}
