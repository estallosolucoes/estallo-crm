import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { Sidebar } from "@/components/shell/Sidebar";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import type { Branding } from "@/lib/branding";
import { MarcaDaInstalacaoProvider } from "@/lib/branding/contexto";

/**
 * O CONSUMIDOR do nome por organização — provado por comportamento, não por
 * símbolo.
 *
 * POR QUE ESTE ARQUIVO EXISTE: medido antes de escrever a feature, o nome da
 * organização não aparecia em lugar nenhum da casca para o cliente típico de um
 * revendedor — o único leitor era o `TenantSwitcher`, que devolve `null` com uma
 * organização só. Gravar `settings.branding.app_name` sem um leitor real teria
 * criado o campo decorativo clássico: a tela oferece, o código ignora, e o
 * cliente conclui que o produto está quebrado.
 *
 * Conferir que a Sidebar MENCIONA `activeOrg.marca` não bastaria — é evidência
 * de símbolo presente, não de comportamento presente. Os dois casos abaixo
 * medem o texto que a barra renderiza, com e sem a marca, e o segundo afirma
 * também a AUSÊNCIA do nome da instalação: sem isso, um componente que
 * mostrasse os dois passaria.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/app/inbox" }));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({ toggleSidebar: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
// Os dois buscam estado do servidor e não têm nada a ver com o nome da marca.
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));
// O contador de casos lê a fila pelo React Query; aqui não há provider, e o
// número não é o objeto destes casos (o dele mora em contador-de-casos.test.tsx).
vi.mock("@/components/shell/ContadorDeCasos", () => ({ ContadorDeCasos: () => null }));
vi.mock("@/components/shell/ContadorDaFila", () => ({ ContadorDaFila: () => null }));
vi.mock("@/components/shell/VersionFooter", () => ({ VersionFooter: () => null }));

/**
 * A marca da INSTALAÇÃO, como o SERVIDOR a entrega.
 *
 * ⚠️ Isto era um `vi.mock("@/lib/branding")` até a correção do hydration
 * mismatch. Não é mais: a barra deixou de chamar `branding()` — que lia
 * `window.__PUBLIC_ENV__` no navegador e `process.env` no SSR, fontes que
 * divergiram quando o layout raiz passou a injetar a marca do BANCO — e passou a
 * receber a marca por PROP, via `MarcaDaInstalacaoProvider`. Montar o provedor
 * aqui é o jeito honesto de simular "o operador gravou um logo na tela de
 * marca": deste lado da fronteira é exatamente o que o layout raiz faz.
 *
 * `logoUrl: null` no padrão porque com logo a barra mostra a imagem NO LUGAR do
 * texto — os três primeiros casos, que medem nome, não mediriam nada.
 */
const marcaDaInstalacao: Branding = {
  name: "Sistema do Revendedor",
  logoUrl: null,
  initial: "S",
};

/** A barra como o layout raiz a monta: dentro do provedor da marca. */
function renderSidebar(props: { collapsed: boolean }) {
  return render(
    <MarcaDaInstalacaoProvider marca={marcaDaInstalacao}>
      <Sidebar collapsed={props.collapsed} />
    </MarcaDaInstalacaoProvider>,
  );
}

const usuario = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@exemplo.test",
  is_platform_admin: false,
  organizations: [],
} as unknown as AuthUser;

const org = {
  orgId: "00000000-0000-4000-8000-0000000000aa",
  name: "Loja da Ana",
  role: "admin",
} as ActiveOrg;

let contexto: { user: AuthUser; activeOrg: ActiveOrg | null } = { user: usuario, activeOrg: org };
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => contexto,
}));

describe("marca da organização não substitui a plataforma", () => {
  it.each([false, true])(
    "nome e logo da organização são ignorados com menu recolhido=%s",
    (collapsed) => {
      contexto = {
        user: usuario,
        activeOrg: {
          ...org,
          marca: { nome: "Marca antiga", logoUrl: "https://example.test/antiga.svg" },
        },
      };
      renderSidebar({ collapsed });
      expect(screen.queryByText("Marca antiga")).toBeNull();
      expect(document.querySelector('img[src="https://example.test/antiga.svg"]')).toBeNull();
      if (!collapsed) expect(screen.getByText("Sistema do Revendedor")).toBeTruthy();
    },
  );
  it("a fonte de identidade recebida do layout permanece igual entre organizações", () => {
    contexto = { user: usuario, activeOrg: org };
    renderSidebar({ collapsed: false });
    expect(screen.getByText("Sistema do Revendedor")).toBeTruthy();
  });
});
