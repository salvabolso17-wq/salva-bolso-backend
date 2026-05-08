import * as os from "os";
import { log } from "../utils/logger";

const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 4000;

// Detecta o IP próprio do container priorizando a rede interna do projeto
// (easypanel-salva-bolso: 10.0.x.x) onde Evolution consegue alcançar o backend
function getSelfIP(): string | null {
  const candidates: string[] = [];

  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (addr.address.startsWith("10.0."))      candidates.unshift(addr.address); // preferred
      else if (addr.address.startsWith("10."))   candidates.push(addr.address);
      else if (addr.address.startsWith("172."))  candidates.push(addr.address);
    }
  }

  return candidates[0] ?? null;
}

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

  const ip = getSelfIP();
  if (!ip) {
    log.error("self-register: IP proprio nao detectado", undefined, {});
    return;
  }

  const webhookUrl = `http://${ip}/webhooks/whatsapp?provider=evolution`;
  log.webhook("self-register: iniciando", { ip, webhookUrl });

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
