import { describe, expect, it } from "vitest";

import { resolveSharedContacts } from "@/lib/messaging/contact-card";
import { ackToStatus } from "@/lib/types/messaging";
import { cartaoDoAnuncio, extrairAtribuicaoWaha } from "@/lib/waha/atribuicao-de-anuncio";
import { previewFromMessage, resolveMessageType } from "@/lib/waha/ingest";
import type { WahaPayload } from "@/lib/waha/envelope";

/**
 * Três achados de produção (Prática Biomed, 29–30/10/2026):
 *
 * 1. Vários contatos numa mensagem chegam como `contactsArrayMessage`, sem
 *    `body`. A ingestão não reconhecia a chave e descartava a mensagem calada.
 * 2. O anúncio de "Clique para o WhatsApp" ia só para a atribuição do contato;
 *    a bolha não mostrava a thumb nem o link.
 * 3. Ack -1 (erro) virava "sending".
 *
 * Payloads com a FORMA real (anonimizados).
 */

const vcard = (nome: string, tel: string) =>
  `BEGIN:VCARD\nVERSION:3.0\nN:;${nome};;;\nFN:${nome}\nitem1.TEL;waid=${tel}:+${tel}\nitem1.X-ABLabel:Celular\nEND:VCARD`;

const contatos = {
  id: "false_5500000000000@c.us_AAAA",
  from: "5500000000000@c.us",
  fromMe: false,
  hasMedia: false,
  _data: {
    message: {
      contactsArrayMessage: {
        displayName: "2 contatos",
        contacts: [
          { displayName: "Ana Teste", vcard: vcard("Ana Teste", "5511900000001") },
          { displayName: "Bruno Teste", vcard: vcard("Bruno Teste", "5511900000002") },
        ],
      },
      messageContextInfo: {},
    },
  },
} as unknown as WahaPayload;

describe("vários contatos (contactsArrayMessage)", () => {
  it("é reconhecido como cartão de contato", () => {
    expect(resolveMessageType(contatos)).toBe("contact");
  });

  it("não é descartado: o corpo junta os vCards e a prévia conta", () => {
    expect(previewFromMessage(contatos)).toBe("Contatos: Ana Teste e mais 1");
  });

  it("a tela lê os dois contatos do corpo", () => {
    const body = contatos._data!.message as { contactsArrayMessage: { contacts: { vcard: string }[] } };
    const corpo = body.contactsArrayMessage.contacts.map((c) => c.vcard).join("\n");
    const lidos = resolveSharedContacts({ type: "contact", body: corpo, metadata: {} });
    expect(lidos.map((c) => c.name)).toEqual(["Ana Teste", "Bruno Teste"]);
    expect(lidos[1]?.phone_number).toBe("+5511900000002");
  });

  it("um contato só continua um cartão só", () => {
    const um = resolveSharedContacts({ type: "contact", body: vcard("Ana Teste", "5511900000001"), metadata: {} });
    expect(um).toHaveLength(1);
  });
});

describe("cartão do anúncio", () => {
  const raw = {
    extendedTextMessage: {
      text: "Olá! Tenho interesse",
      contextInfo: {
        externalAdReply: {
          title: "Pare de travar na coleta",
          body: "Criamos um treinamento…",
          sourceType: "ad",
          sourceId: "52538348261289",
          sourceApp: "instagram",
          sourceUrl: "https://www.instagram.com/p/XYZ/",
          thumbnailUrl: "https://cdn.example/thumb.jpg?oe=6AEACB44",
          thumbnail: "iVBORw0KGgo=",
        },
      },
    },
  };

  it("projeta título, link, app e as duas miniaturas", () => {
    const a = extrairAtribuicaoWaha(raw);
    expect(a).not.toBeNull();
    expect(cartaoDoAnuncio(a!)).toEqual({
      titulo: "Pare de travar na coleta",
      corpo: "Criamos um treinamento…",
      url: "https://www.instagram.com/p/XYZ/",
      app: "instagram",
      thumb_url: "https://cdn.example/thumb.jpg?oe=6AEACB44",
      thumb_b64: "iVBORw0KGgo=",
    });
  });
});

describe("ack do WAHA", () => {
  it("-1 é falha; 2 entregue; 3 lida", () => {
    expect(ackToStatus(-1)).toBe("failed");
    expect(ackToStatus(2)).toBe("delivered");
    expect(ackToStatus(3)).toBe("read");
  });
});
