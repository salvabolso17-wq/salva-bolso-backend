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
  const ts = new Date().toISOString();
  try {
    const provider = (req.query.provider as string) ?? "meta";
    const body     = req.body as Record<string, unknown>;
    const data     = body.data as Record<string, unknown> | undefined;
    const key      = data?.key as Record<string, unknown> | undefined;
    const msgObj   = data?.message as Record<string, unknown> | undefined;

    console.log(`[webhook ${ts}] RAW provider=${provider} event=${body.event} remoteJid=${key?.remoteJid} remoteJidAlt=${key?.remoteJidAlt} fromMe=${key?.fromMe} text=${msgObj?.conversation ?? (msgObj?.extendedTextMessage as Record<string,unknown>)?.text ?? "(sem texto)"}`);

    const message = normalizePayload(body, provider);

    if (!message) {
      console.log(`[webhook ${ts}] normalizePayload retornou null — payload descartado (grupo, fromMe, ou formato desconhecido)`);
      res.status(200).json({ received: true, processed: false, error: "Payload não reconhecido ou mensagem não é texto" });
      return;
    }

    console.log(`[webhook ${ts}] normalizado OK — telefone=${message.telefone} texto="${message.texto}" messageId=${message.messageId}`);

    const result = await processWhatsAppMessage(message);

    if (result.success) {
      console.log(`[webhook ${ts}] processado OK — userId=${result.userId} transacaoId=${(result.transacao as Record<string,unknown>)?.id}`);
    } else {
      console.log(`[webhook ${ts}] processado com erro — userId=${result.userId ?? "N/A"} erro="${result.erro}"`);
    }

    res.status(200).json({
      received: true,
      processed: result.success,
      provider,
      messageId: message.messageId,
      ...(result.success
        ? { data: { usuario_id: result.userId, transacao: result.transacao, interpretado: result.interpretado } }
        : { error: result.erro }),
    });
  } catch (error) {
    console.error(`[webhook ${ts}] ERRO INTERNO:`, error);
    res.status(200).json({ received: true, processed: false, error: "Erro interno" });
  }
});

export default router;
