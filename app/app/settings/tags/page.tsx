import { redirect } from "next/navigation";

/** A tela de Tags mudou para o CRM (Estallo, 0659). O endereço antigo continua chegando lá. */
export default function TagsAntigaPage() {
  redirect("/app/crm/tags");
}
