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

// Busca o telefone do customer no Asaas (fallback quando externalReference está ausente)
async function fetchAsaasCustomerPhone(customerId: string): Promise<string | null> {
  const apiKey  = process.env.ASAAS_API_KEY;
  const baseUrl = (process.env.ASAAS_API_URL ?? "https://api.asaas.com/v3").replace(/\/$/, "");

  if (!apiKey) {
    log.error("asaas: ASAAS_API_KEY nao configurado", undefined, { customerId });
    return null;
  }

  try {
    const res = await fetch(`${baseUrl}/customers/${customerId}`, {
      headers: { "access_token": apiKey },
    });

    if (!res.ok) {
      log.error("asaas: falha ao buscar customer", undefined, { customerId, status: res.status });
      return null;
    }

    const data = await res.json() as Record<string, unknown>;
    const phone = (data.mobilePhone ?? data.phone) as string | undefined;
    log.webhook("asaas: telefone obtido do customer", { customerId, phone: phone ?? "(nenhum)" });
    return phone ?? null;
  } catch (err) {
    log.error("asaas: erro na chamada de customer", err, { customerId });
    return null;
  }
}

// POST /webhooks/asaas — ativa usuário quando pagamento é confirmado
router.post("/asaas", async (req, res) => {
  try {
    console.error("[ASAAS] webhook recebido — body:", JSON.stringify(req.body).slice(0, 500));

    // Valida token do Asaas (configurar ASAAS_WEBHOOK_TOKEN no .env / EasyPanel)
    const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN;
    if (webhookToken) {
      const received = req.headers["asaas-access-token"];
      if (received !== webhookToken) {
        console.error("[ASAAS] token invalido, recebido:", received ?? "(ausente)");
        res.status(200).json({ received: true, error: "Token inválido" });
        return;
      }
    }

    const body    = req.body as Record<string, unknown>;
    const event   = body.event as string | undefined;
    const payment = body.payment as Record<string, unknown> | undefined;

    console.error("[ASAAS] event:", event, "paymentId:", payment?.id);

    // Apenas processa confirmações de pagamento
    if (event !== "PAYMENT_CONFIRMED" && event !== "PAYMENT_RECEIVED") {
      console.error("[ASAAS] evento ignorado:", event);
      res.status(200).json({ received: true, ignored: true, event });
      return;
    }

    // Resolve telefone: externalReference → fallback via customer API
    let telefoneRaw = payment?.externalReference as string | undefined;
    console.error("[ASAAS] externalReference:", telefoneRaw ?? "(ausente)");

    if (!telefoneRaw) {
      const customerId = payment?.customer as string | undefined;
      console.error("[ASAAS] customer id:", customerId ?? "(ausente)");

      if (!customerId) {
        console.error("[ASAAS] sem externalReference e sem customer — abortando");
        res.status(200).json({ received: true, error: "Sem identificador de usuário" });
        return;
      }

      console.error("[ASAAS] buscando telefone via GET /customers/" + customerId);
      const phone = await fetchAsaasCustomerPhone(customerId);
      console.error("[ASAAS] telefone retornado:", phone ?? "(nulo)");

      if (!phone) {
        res.status(200).json({ received: true, error: "Telefone do customer não encontrado" });
        return;
      }
      telefoneRaw = phone;
    }

    const telefone = telefoneRaw.replace(/\D/g, "");
    console.error("[ASAAS] telefone normalizado:", telefone);

    // Ativa usuário — idempotente (só atualiza se ainda não for 'active')
    console.error("[ASAAS] executando UPDATE no banco...");
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

    console.error("[ASAAS] rowCount do UPDATE:", result.rowCount);

    if (result.rowCount === 0) {
      console.error("[ASAAS] usuario ja ativo ou nao encontrado para telefone:", telefone);
      res.status(200).json({ received: true, alreadyActive: true });
      return;
    }

    const user = result.rows[0];
    console.error("[ASAAS] usuario ativado:", user.id, user.telefone);
    log.webhook("asaas: usuario ativado", {
      userId: user.id, telefone: user.telefone, paymentId: payment?.id,
    });

    // Notifica o usuário no WhatsApp
    try {
      await whatsapp.sendText({
        to:   user.telefone,
        text: "✅ Assinatura ativada!\n\nBem-vindo ao Salva Bolso 🚀",
      });
      console.error("[ASAAS] notificacao WhatsApp enviada para:", user.telefone);
    } catch (err) {
      console.error("[ASAAS] falha ao notificar WhatsApp:", err);
      log.error("asaas: falha ao notificar usuario", err, { userId: user.id });
    }

    res.status(200).json({ received: true, activated: true, userId: user.id });
  } catch (err) {
    console.error("[ASAAS] ERRO INTERNO NO WEBHOOK:", err);
    log.error("asaas: erro interno no webhook", err);
    res.status(200).json({ received: true });
  }
});

export default router;
