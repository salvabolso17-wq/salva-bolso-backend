export interface NormalizedMessage {
  telefone: string;
  texto: string;
  messageId: string;
  provider: string;
}

// Meta WhatsApp Cloud API
function parseMeta(body: Record<string, unknown>): NormalizedMessage | null {
  try {
    const entry  = (body.entry  as Record<string, unknown>[])?.[0];
    const change = (entry?.changes as Record<string, unknown>[])?.[0];
    const value  = change?.value as Record<string, unknown>;
    const msg    = (value?.messages as Record<string, unknown>[])?.[0];

    if (!msg || msg.type !== "text") return null;

    const from = msg.from as string;
    const body_ = (msg.text as Record<string, string>)?.body;
    if (!from || !body_) return null;

    return { telefone: from, texto: body_, messageId: String(msg.id ?? ""), provider: "meta" };
  } catch {
    return null;
  }
}

// Evolution API
function parseEvolution(body: Record<string, unknown>): NormalizedMessage | null {
  try {
    const data = body.data as Record<string, unknown>;
    const key  = data?.key as Record<string, string>;
    const msg  = data?.message as Record<string, unknown>;

    const conv = msg?.conversation ?? (msg?.extendedTextMessage as Record<string, string>)?.text;
    const texto = typeof conv === "string" ? conv : null;
    const telefone = key?.remoteJid?.replace("@s.whatsapp.net", "");

    if (!telefone || !texto) return null;

    return { telefone, texto, messageId: key?.id ?? "", provider: "evolution" };
  } catch {
    return null;
  }
}

// 360dialog
function parse360Dialog(body: Record<string, unknown>): NormalizedMessage | null {
  try {
    const msg = (body.messages as Record<string, unknown>[])?.[0];
    if (!msg || msg.type !== "text") return null;

    const from  = msg.from as string;
    const body_ = (msg.text as Record<string, string>)?.body;
    if (!from || !body_) return null;

    return { telefone: from, texto: body_, messageId: String(msg.id ?? ""), provider: "360dialog" };
  } catch {
    return null;
  }
}

export function normalizePayload(
  body: Record<string, unknown>,
  provider: string
): NormalizedMessage | null {
  switch (provider) {
    case "meta":      return parseMeta(body);
    case "evolution": return parseEvolution(body);
    case "360dialog": return parse360Dialog(body);
    default:          return null;
  }
}
