import { Router } from "express";
import pool from "../db/client";
import { normalizePayload } from "../adapters/whatsappAdapters";
import { processWhatsAppMessage } from "../services/whatsappService";
import { whatsapp } from "../services/whatsapp";
import { log } from "../utils/logger";

const router = Router();

router.get("/whatsapp", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
    return;
  }

  res.status(403).json({ error: "Verificação falhou" });
});

// POST /webhooks/whatsapp?provider=meta|evolution|360dialog
router.post("/whatsapp", async (req, res) => {
  console.log("[WHATSAPP-HIT] rota atingida, body keys:", Object.keys(req.body ?? {}));
  const start    = Date.now();
  const provider = (req.query.provider as string) ?? "meta";
  const body     = req.body as Record<string, unknown>;
  const data     = body.data as Record<string, unknown> | undefined;
  const key      = data?.key as Record<string, unknown> | undefined;
  const msgObj   = data?.message as Record<string, unknown> | undefined;
  const text     = msgObj?.conversation
    ?? (msgObj?.extendedTextMessage as Record<string, unknown>)?.text
    ?? "(sem texto)";

  log.webhook("recebido", {
    provider,
    event:        body.event,
    remoteJid:    key?.remoteJid,
    remoteJidAlt: key?.remoteJidAlt,
    fromMe:       key?.fromMe,
    text,
  });

  try {
    const message = normalizePayload(body, provider);

    if (!message) {
      const motivo = key?.fromMe === true
        ? "fromMe=true (mensagem própria)"
        : String(key?.remoteJid ?? "").endsWith("@g.us")
          ? "grupo (@g.us)"
          : "payload não reconhecido ou sem texto";

      log.webhook("descartado", { motivo });
      res.status(200).json({ received: true, processed: false, reason: motivo });
      return;
    }

    log.webhook("normalizado", {
      telefone:  message.telefone,
      texto:     message.texto,
      messageId: message.messageId,
    });

    const result = await processWhatsAppMessage(message);
    const elapsed = Date.now() - start;

    if (result.success) {
      log.webhook("concluido", {
        elapsed: `${elapsed}ms`,
        userId:      result.userId,
        transacaoId: (result.transacao as Record<string, unknown>)?.id,
      });
    } else {
      log.webhook("falhou", { elapsed: `${elapsed}ms`, motivo: result.erro });
    }

    res.status(200).json({
      received: true,
      processed: result.success,
      provider,
      messageId: message.messageId,
      elapsed: `${elapsed}ms`,
      ...(result.success
        ? { data: { usuario_id: result.userId, transacao: result.transacao, interpretado: result.interpretado } }
        : { error: result.erro }),
    });
  } catch (err) {
    const elapsed = Date.now() - start;
    log.error("erro interno no webhook", err, { provider, elapsed: `${elapsed}ms` });
    res.status(200).json({ received: true, processed: false, error: "Erro interno" });
  }
});

// STUB — rota mínima para isolar Bad Gateway
router.get("/asaas", (_req, res) => {
  res.status(200).send("asaas ok");
});

router.post("/asaas", (req, res) => {
  console.log("[ASAAS] webhook simples funcionando");
  return res.status(200).json({ ok: true });
});

export default router;
