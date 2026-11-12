/** Catálogo exclusivamente demonstrativo. Não cria assinaturas nem aplica limites. */
export const PLANOS_DEMONSTRATIVOS = [
  {
    id: "essencial",
    nome: "Essencial",
    descricao: "Para organizar os primeiros atendimentos.",
    preco_cents: 9700,
    usuarios: 3,
    canais: 1,
    contatos: 1000,
    destaque: false,
  },
  {
    id: "profissional",
    nome: "Profissional",
    descricao: "Para uma equipe que vende e atende todos os dias.",
    preco_cents: 19700,
    usuarios: 10,
    canais: 3,
    contatos: 5000,
    destaque: true,
  },
  {
    id: "escala",
    nome: "Escala",
    descricao: "Para operações com mais pessoas e conexões.",
    preco_cents: 39700,
    usuarios: 25,
    canais: 5,
    contatos: 20000,
    destaque: false,
  },
] as const;

export function precoDemonstrativo(preco_cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(preco_cents / 100);
}
