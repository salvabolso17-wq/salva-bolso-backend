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

// POST /webhooks/asaas — ativa usuário quando pagamento é confirmado
router.post("/asaas", async (req, res) => {
  // Valida token do Asaas (configurar ASAAS_WEBHOOK_TOKEN no .env / EasyPanel)
  const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN;
  if (webhookToken) {
    const received = req.headers["asaas-access-token"];
    if (received !== webhookToken) {
      log.error("asaas webhook: token invalido", undefined, { received: received ?? "(ausente)" });
      res.status(401).json({ error: "Token inválido" });
      return;
    }
  }

  const body    = req.body as Record<string, unknown>;
  const event   = body.event as string | undefined;
  const payment = body.payment as Record<string, unknown> | undefined;

  log.webhook("asaas evento recebido", { event, paymentId: payment?.id });

  // Apenas processa confirmações de pagamento
  if (event !== "PAYMENT_CONFIRMED" && event !== "PAYMENT_RECEIVED") {
    res.status(200).json({ received: true, ignored: true, event });
    return;
  }

  const telefoneRaw = payment?.externalReference as string | undefined;
  if (!telefoneRaw) {
    log.error("asaas: externalReference ausente", undefined, { paymentId: payment?.id });
    res.status(200).json({ received: true, error: "externalReference ausente" });
    return;
  }

  const telefone = telefoneRaw.replace(/\D/g, "");

  try {
    // Ativa usuário — idempotente (só atualiza se ainda não for 'active')
    const result = await pool.query<{ id: number; telefone: string }>(
      `UPDATE users
       SET subscription_status = 'active'
       WHERE (
         REGEXP_REPLACE(telefone, '[^0-9]', '', 'g') = $1
         OR RIGHT(REGEXP_REPLACE(telefone, '[^0-9]', '', 'g'), 11) = RIGHT($1, 11)
       )
       AND subscription_status != 'active'
       RETURNING id, telefone`,
      [telefone]
    );

    if (result.rowCount === 0) {
      log.webhook("asaas: usuario ja ativo ou nao encontrado", { telefone });
      res.status(200).json({ received: true, alreadyActive: true });
      return;
    }

    const user = result.rows[0];
    log.webhook("asaas: usuario ativado", {
      userId: user.id, telefone: user.telefone, paymentId: payment?.id,
    });

    // Notifica o usuário no WhatsApp
    try {
      await whatsapp.sendText({
        to:   user.telefone,
        text: "✅ Assinatura ativada!\n\nBem-vindo ao Salva Bolso 🚀",
      });
    } catch (err) {
      log.error("asaas: falha ao notificar usuario", err, { userId: user.id });
    }

    res.status(200).json({ received: true, activated: true, userId: user.id });
  } catch (err) {
    log.error("asaas: erro ao processar webhook", err, { event, telefone });
    res.status(200).json({ received: true, error: "Erro interno" });
  }
});

export default router;
