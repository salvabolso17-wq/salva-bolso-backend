import * as os from "os";
import { log } from "../utils/logger";

const MAX_ATTEMPTS  = 8;
const INITIAL_DELAY = 2_000;

// Retorna o IP do container na rede interna do projeto (10.0.x.x preferido)
function getSelfIP(): string | null {
  const candidates: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (addr.address.startsWith("10.0."))     candidates.unshift(addr.address);
      else if (addr.address.startsWith("10."))  candidates.push(addr.address);
      else if (addr.address.startsWith("172.")) candidates.push(addr.address);
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
      signal: AbortSignal.timeout(10_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function selfRegisterWebhook(): Promise<void> {
  if (process.env.WHATSAPP_PROVIDER !== "evolution") return;

  const port = process.env.PORT ?? "3000";
  const ip   = getSelfIP();

  if (!ip) {
    log.error("self-register: IP proprio nao detectado", undefined, {});
    return;
  }

  const webhookUrl = `http://${ip}:${port}/webhooks/whatsapp?provider=evolution`;
  log.webhook("self-register: iniciando", { ip, port, webhookUrl });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ok = await callWebhookSet(webhookUrl);
    if (ok) {
      log.webhook("self-register: webhook registrado", { webhookUrl, attempt });
      return;
    }

    if (attempt === MAX_ATTEMPTS) {
      log.error("self-register: CRITICO — Evolution nao respondeu apos 8 tentativas, encerrando sem travar", undefined, { webhookUrl, attempt });
      return;
    }

    const delayMs = INITIAL_DELAY * Math.pow(2, attempt - 1);
    log.webhook("self-register: aguardando Evolution ficar disponivel", { attempt, proximaTentativa: attempt + 1, delayMs });
    await new Promise(r => setTimeout(r, delayMs));
  }
}
