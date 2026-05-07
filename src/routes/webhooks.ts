import { Router } from "express";
import { normalizePayload } from "../adapters/whatsappAdapters";
import { processWhatsAppMessage } from "../services/whatsappService";

const router = Router();

// Verificação do webhook — exigida pela Meta Cloud API
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
// Sempre retorna 200 para evitar reenvios automáticos do provider
router.post("/whatsapp", async (req, res) => {
  try {
    const provider = (req.query.provider as string) ?? "meta";
    const body     = req.body as Record<string, unknown>;

    // Debug: log raw payload to diagnose LID/phone issues
    console.log("[webhook] provider=%s event=%s remoteJid=%s remoteJidAlt=%s fromMe=%s text=%s",
      provider,
      body.event,
      (body.data as Record<string, unknown>)?.key
        ? ((body.data as Record<string, unknown>).key as Record<string, unknown>)?.remoteJid
        : "?",
      (body.data as Record<string, unknown>)?.key
        ? ((body.data as Record<string, unknown>).key as Record<string, unknown>)?.remoteJidAlt
        : "?",
      (body.data as Record<string, unknown>)?.key
        ? ((body.data as Record<string, unknown>).key as Record<string, unknown>)?.fromMe
        : "?",
      (body.data as Record<string, unknown>)?.message
        ? (((body.data as Record<string, unknown>).message as Record<string, unknown>)?.conversation
          ?? ((body.data as Record<string, unknown>).message as Record<string, unknown>)?.extendedTextMessage)
        : "?"
    );

    const message = normalizePayload(body, provider);

    if (!message) {
      res.status(200).json({
        received: true,
        processed: false,
        error: "Payload não reconhecido ou mensagem não é texto",
      });
      return;
    }

    const result = await processWhatsAppMessage(message);

    res.status(200).json({
      received: true,
      processed: result.success,
      provider,
      messageId: message.messageId,
      ...(result.success
        ? {
            data: {
              usuario_id: result.userId,
              transacao:  result.transacao,
              interpretado: result.interpretado,
            },
          }
        : { error: result.erro }),
    });
  } catch (error) {
    console.error(error);
    res.status(200).json({ received: true, processed: false, error: "Erro interno" });
  }
});

export default router;
