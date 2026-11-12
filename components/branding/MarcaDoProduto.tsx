import { LOGOTIPO, SIMBOLO } from "@/lib/branding/desenho";
import { cn } from "@/lib/utils";

type Props = { readonly nome: string; readonly className?: string; readonly decorativo?: boolean };

export const CLASSES_DE_COR = {
  simbolo: "marca-azul fill-[#1099d3] dark:fill-[#54bce8]",
  nome: "marca-nome fill-[#26333d] dark:fill-[#f8fafb]",
  sufixo: "marca-sufixo fill-[#536573] dark:fill-[#c4cdd4]",
} as const;

function acessibilidade(nome: string, decorativo: boolean) {
  return decorativo
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": nome } as const);
}

function corDoTraco(papel: string) {
  return papel === "verde"
    ? "fill-[#10ba84]"
    : papel === "azul"
      ? CLASSES_DE_COR.simbolo
      : CLASSES_DE_COR.nome;
}

/** S?mbolo oficial compartilhado com onboarding e ?cones do aplicativo. */
export function SimboloDoProduto({ nome, className, decorativo = false }: Props) {
  return (
    <svg
      viewBox={SIMBOLO.viewBox}
      className={cn("shrink-0", className)}
      {...acessibilidade(nome, decorativo)}
    >
      {SIMBOLO.paths.map((traco, indice) => (
        <path key={indice} d={traco.d} className={corDoTraco(traco.papel)} />
      ))}
    </svg>
  );
}

/** Assinatura oficial com o descritor da categoria, servida pelo pr?prio aplicativo. */
export function LogotipoDoProduto({ nome, className, decorativo = false }: Props) {
  return (
    <svg
      viewBox="0 0 2620 724"
      className={cn("shrink-0", className)}
      {...acessibilidade(nome, decorativo)}
    >
      <title>{nome}</title>
      {LOGOTIPO.paths.map((traco, indice) => (
        <path key={indice} d={traco.d} className={corDoTraco(traco.papel)} />
      ))}
      <text x="2200" y="468" fontSize="170" fontWeight="600" className={CLASSES_DE_COR.sufixo}>
        CRM
      </text>
    </svg>
  );
}
