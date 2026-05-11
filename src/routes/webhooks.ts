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

  if (!apiKey) return null;

  try {
    const res = await fetch(`${baseUrl}/customers/${customerId}`, {
      headers: { "access_token": apiKey },
    });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    return ((data.mobilePhone ?? data.phone) as string | undefined) ?? null;
  } catch {
    return null;
  }
}

// POST /webhooks/asaas — ativa usuário quando pagamento é confirmado
router.post("/asaas", async (req, res) => {
  try {
    console.error("[ASAAS] webhook recebido — body:", JSON.stringify(req.body).slice(0, 300));

    const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN;
    if (webhookToken && req.headers["asaas-access-token"] !== webhookToken) {
      console.error("[ASAAS] token invalido");
      res.status(200).json({ received: true, error: "Token inválido" });
      return;
    }

    const body    = req.body as Record<string, unknown>;
    const event   = body.event as string | undefined;
    const payment = body.payment as Record<string, unknown> | undefined;
    const paymentId = payment?.id as string | undefined;

    console.error("[ASAAS] event:", event, "paymentId:", paymentId);

    if (event !== "PAYMENT_CONFIRMED" && event !== "PAYMENT_RECEIVED") {
      res.status(200).json({ received: true, ignored: true, event });
      return;
    }
    
    if (paymentId) {
      try {
        const dedup = await pool.query(
          `INSERT INTO processed_messages (message_id, telefone)
           VALUES ($1, $2)
           ON CONFLICT (message_id) DO NOTHING`,
          [`asaas_payment_${paymentId}`, "webhook_asaas"]
        );

        if (dedup.rowCount === 0) {
          console.error("[ASAAS] webhook duplicado/já processado para o paymentId:", paymentId);
          res.status(200).json({ received: true, ignored: true, reason: "duplicate" });
          return;
        }
      } catch (err) {
        console.error("[ASAAS] erro na verificacao de duplicidade asaas", err);
      }
    }

    let telefoneRaw = payment?.externalReference as string | undefined;
    console.error("[ASAAS] externalReference:", telefoneRaw ?? "(ausente)");

    if (!telefoneRaw) {
      const customerId = payment?.customer as string | undefined;
      console.error("[ASAAS] buscando telefone via customer:", customerId ?? "(ausente)");
      if (!customerId) {
        res.status(200).json({ received: true, error: "Sem identificador de usuário" });
        return;
      }
      const phone = await fetchAsaasCustomerPhone(customerId);
      console.error("[ASAAS] telefone retornado:", phone ?? "(nulo)");
      if (!phone) {
        res.status(200).json({ received: true, error: "Telefone não encontrado" });
        return;
      }
      telefoneRaw = phone;
    }

    const telefone = telefoneRaw.replace(/\D/g, "");

    // Gera variantes para cobrir reforma do 9 dígito e DDI 55
    const variants = new Set<string>([telefone]);
    const expand = (t: string) => {
      if (t.length === 13) { // 55+DDD+9+local
        const s = t.slice(2); variants.add(s);                          // DDD+9+local
        const n = s.slice(0, 2) + s.slice(3); variants.add(n); variants.add("55" + n); // sem 9
      } else if (t.length === 12) { // 55+DDD+local
        const s = t.slice(2); variants.add(s);                          // DDD+local
        const c = s.slice(0, 2) + "9" + s.slice(2); variants.add(c); variants.add("55" + c); // com 9
      } else if (t.length === 11) { // DDD+9+local
        variants.add("55" + t);
        const n = t.slice(0, 2) + t.slice(3); variants.add(n); variants.add("55" + n);
      } else if (t.length === 10) { // DDD+local
        variants.add("55" + t);
        const c = t.slice(0, 2) + "9" + t.slice(2); variants.add(c); variants.add("55" + c);
      }
    };
    expand(telefone);
    const variantsArr = Array.from(variants);
    console.error("[ASAAS] variantes de telefone:", variantsArr);

    // Detecta plano pelo description do pagamento
    const description = ((payment?.description ?? payment?.billingType ?? "") as string).toLowerCase();
    const planRow = await pool.query<{ nome: string; duration_days: number }>(
      `SELECT nome, duration_days FROM plans WHERE ativo = true AND $1 ILIKE '%' || nome || '%' LIMIT 1`,
      [description]
    );
    const plan = planRow.rows[0] ?? { nome: "mensal", duration_days: 30 };
    console.error("[ASAAS] plano detectado:", plan.nome, `(${plan.duration_days} dias)`);

    const result = await pool.query<{ id: number; telefone: string; prev_status: string }>(
      `WITH prev AS (
         SELECT id, subscription_status AS prev_status
         FROM users
         WHERE REGEXP_REPLACE(telefone, '[^0-9]', '', 'g') = ANY($1::text[])
         LIMIT 1
       )
       UPDATE users u
       SET subscription_status      = 'active',
           subscription_expires_at  = NOW() + ($2 || ' days')::INTERVAL,
           current_plan             = $3
       FROM prev
       WHERE u.id = prev.id
       RETURNING u.id, u.telefone, prev.prev_status`,
      [variantsArr, plan.duration_days.toString(), plan.nome]
    );

    console.error("[ASAAS] rowCount:", result.rowCount);

    if (result.rowCount === 0) {
      res.status(200).json({ received: true, updated: false });
      return;
    }

    const user = result.rows[0];
    const isRenovacao = user.prev_status === "expired";
    console.error("[ASAAS] usuario ativado:", user.id, user.telefone, isRenovacao ? "(renovacao)" : "(novo)");
    log.webhook("asaas: usuario ativado", { userId: user.id, telefone: user.telefone, paymentId: payment?.id, isRenovacao });

    const texto = `🎉 Premium ativado com sucesso!\n\nAgora você tem acesso completo ao Salva Bolso:\n💰 registro ilimitado de gastos\n📊 relatórios financeiros detalhados\n🎯 metas personalizadas\n🔄 controle de gastos recorrentes\n📅 acompanhamento mensal completo\n👀 consulta de saldo e histórico\n⚡ acesso total aos recursos Premium\n\nPode continuar usando normalmente ✨`;

    try {
      await whatsapp.sendText({ to: user.telefone, text: texto });
    } catch (err) {
      console.error("[ASAAS] falha ao notificar WhatsApp:", err);
    }

    res.status(200).json({ received: true, activated: true, userId: user.id });
  } catch (err) {
    console.error("[ASAAS] ERRO INTERNO:", err);
    res.status(200).json({ received: true });
  }
});

export default router;
