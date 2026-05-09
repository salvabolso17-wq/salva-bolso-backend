import { log } from "../utils/logger";

const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 4000;

async function callWebhookSet(webhookUrl: string): Promise<boolean> {
  const evolutionUrl      = process.env.WHATSAPP_EVOLUTION_URL;
  const evolutionKey      = process.env.WHATSAPP_EVOLUTION_KEY;
  const evolutionInstance = process.env.WHATSAPP_EVOLUTION_INSTANCE;

  if (!evolutionUrl || !evolutionKey || !evolutionInstance) return false;

  try {
    const resp = await fetch(`${evolutionUrl}/webhook/set/${evolutionInstance}`, {
      method:  "POST",
      headers: { apikey: evolutionKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        webhook: {
          url:      webhookUrl,
          enabled:  true,
          byEvents: false,
          base64:   false,
          events:   ["MESSAGES_UPSERT"],
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function selfRegisterWebhook(): Promise<void> {
  if (process.env.WHATSAPP_PROVIDER !== "evolution") return;

  // Usa URL interna (service name Docker) para evitar hairpin NAT.
  // WEBHOOK_SELF_URL sobrescreve se necessário.
  const port = process.env.PORT ?? "3000";
  const defaultInternal = `http://salva-bolso_backend-salvabolso:${port}/webhooks/whatsapp?provider=evolution`;
  const webhookUrl = (process.env.WEBHOOK_SELF_URL ?? defaultInternal).replace(/\/$/, "");

  log.webhook("self-register: iniciando", { webhookUrl });

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    const ok = await callWebhookSet(webhookUrl);
    if (ok) {
      log.webhook("self-register: webhook registrado", { webhookUrl, attempt });
      return;
    }
    if (attempt < RETRY_ATTEMPTS) {
      log.webhook("self-register: aguardando Evolution ficar disponivel", { attempt, retryMs: RETRY_DELAY_MS });
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  log.error("self-register: todas as tentativas falharam", undefined, { webhookUrl, attempts: RETRY_ATTEMPTS });
}
