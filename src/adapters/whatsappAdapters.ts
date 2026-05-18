export interface NormalizedMessage {
  telefone: string;
  texto: string;
  messageId: string;
  provider: string;
  pushName?: string;
  quotedText?: string;
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

    // Ignore own messages sent by the bot
    if (key?.fromMe === "true" || (key as unknown as Record<string, unknown>)?.fromMe === true) return null;

    // Ignore group messages
    const remoteJid = key?.remoteJid ?? "";
    if (remoteJid.endsWith("@g.us")) return null;

    const extMsg = msg?.extendedTextMessage as Record<string, unknown> | undefined;
    const conv = msg?.conversation ?? extMsg?.text;
    const texto = typeof conv === "string" ? conv : null;

    const ctxInfo = extMsg?.contextInfo as Record<string, unknown> | undefined;
    const quotedMsg = ctxInfo?.quotedMessage as Record<string, unknown> | undefined;
    const quotedRaw = quotedMsg?.conversation ?? (quotedMsg?.extendedTextMessage as Record<string, string> | undefined)?.text;
    const quotedText = typeof quotedRaw === "string" ? quotedRaw : undefined;
    if (quotedText) {
      // eslint-disable-next-line no-console
      console.log("[evolution:quoted]", JSON.stringify({ quotedText, texto }));
    }

    // LID mode: remoteJid is like "277...@lid", real phone is in remoteJidAlt
    let telefone: string | undefined;
    if (remoteJid.endsWith("@lid")) {
      const remoteJidAlt = key?.remoteJidAlt ?? (data?.remoteJidAlt as string);
      telefone = remoteJidAlt?.replace("@s.whatsapp.net", "");
    } else {
      telefone = remoteJid.replace("@s.whatsapp.net", "");
    }

    if (!telefone || !texto) return null;

    const rawPushName = data?.pushName as string | undefined;
    const pushName = rawPushName && /[a-zA-ZÀ-ÿ]/.test(rawPushName) ? rawPushName.trim() : undefined;

    return { telefone, texto, messageId: key?.id ?? "", provider: "evolution", pushName, quotedText };
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
