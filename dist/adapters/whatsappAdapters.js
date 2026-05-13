"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePayload = normalizePayload;
// Meta WhatsApp Cloud API
function parseMeta(body) {
    try {
        const entry = body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;
        const msg = value?.messages?.[0];
        if (!msg || msg.type !== "text")
            return null;
        const from = msg.from;
        const body_ = msg.text?.body;
        if (!from || !body_)
            return null;
        return { telefone: from, texto: body_, messageId: String(msg.id ?? ""), provider: "meta" };
    }
    catch {
        return null;
    }
}
// Evolution API
function parseEvolution(body) {
    try {
        const data = body.data;
        const key = data?.key;
        const msg = data?.message;
        // Ignore own messages sent by the bot
        if (key?.fromMe === "true" || key?.fromMe === true)
            return null;
        // Ignore group messages
        const remoteJid = key?.remoteJid ?? "";
        if (remoteJid.endsWith("@g.us"))
            return null;
        const conv = msg?.conversation ?? msg?.extendedTextMessage?.text;
        const texto = typeof conv === "string" ? conv : null;
        // LID mode: remoteJid is like "277...@lid", real phone is in remoteJidAlt
        let telefone;
        if (remoteJid.endsWith("@lid")) {
            const remoteJidAlt = key?.remoteJidAlt ?? data?.remoteJidAlt;
            telefone = remoteJidAlt?.replace("@s.whatsapp.net", "");
        }
        else {
            telefone = remoteJid.replace("@s.whatsapp.net", "");
        }
        if (!telefone || !texto)
            return null;
        const rawPushName = data?.pushName;
        const pushName = rawPushName && /[a-zA-ZÀ-ÿ]/.test(rawPushName) ? rawPushName.trim() : undefined;
        return { telefone, texto, messageId: key?.id ?? "", provider: "evolution", pushName };
    }
    catch {
        return null;
    }
}
// 360dialog
function parse360Dialog(body) {
    try {
        const msg = body.messages?.[0];
        if (!msg || msg.type !== "text")
            return null;
        const from = msg.from;
        const body_ = msg.text?.body;
        if (!from || !body_)
            return null;
        return { telefone: from, texto: body_, messageId: String(msg.id ?? ""), provider: "360dialog" };
    }
    catch {
        return null;
    }
}
function normalizePayload(body, provider) {
    switch (provider) {
        case "meta": return parseMeta(body);
        case "evolution": return parseEvolution(body);
        case "360dialog": return parse360Dialog(body);
        default: return null;
    }
}
