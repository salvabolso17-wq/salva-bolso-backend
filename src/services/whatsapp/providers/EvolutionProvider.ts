import type { IWhatsAppProvider, SendTextParams, SendTemplateParams, SendResult } from "../types";
import { log } from "../../../utils/logger";

/**
 * Evolution API (self-hosted).
 * Env: WHATSAPP_EVOLUTION_URL, WHATSAPP_EVOLUTION_KEY, WHATSAPP_EVOLUTION_INSTANCE
 * Docs: https://doc.evolution-api.com
 */

// Baileys delivery status codes
const DELIVERY_STATUS: Record<string, string> = {
  PENDING:      "na fila local (não enviado ao servidor)",
  SERVER_ACK:   "enviado ao servidor WhatsApp",
  DELIVERY_ACK: "entregue ao dispositivo",
  READ:         "lido pelo destinatário",
  ERROR:        "ERRO — falha no envio",
};

// Cache do estado da instância para não bater a API a cada envio
let instanceStateCache: { state: string; ts: number } | null = null;
const INSTANCE_STATE_TTL = 20_000; // 20s

type EvolutionResponse = {
  key?:    { id?: string; remoteJid?: string };
  status?: string;
  error?:  string | { message?: string };
};

export class EvolutionProvider implements IWhatsAppProvider {
  readonly name = "evolution";

  private get baseUrl(): string {
    return `${process.env.WHATSAPP_EVOLUTION_URL}/message/sendText/${process.env.WHATSAPP_EVOLUTION_INSTANCE}`;
  }

  private get headers(): Record<string, string> {
    return {
      apikey: process.env.WHATSAPP_EVOLUTION_KEY!,
      "Content-Type": "application/json",
    };
  }

  private envOk(): boolean {
    return !!(
      process.env.WHATSAPP_EVOLUTION_URL &&
      process.env.WHATSAPP_EVOLUTION_KEY &&
      process.env.WHATSAPP_EVOLUTION_INSTANCE
    );
  }

  // Verifica estado da conexão Baileys (open / close / connecting)
  async checkInstanceState(): Promise<string> {
    if (instanceStateCache && Date.now() - instanceStateCache.ts < INSTANCE_STATE_TTL) {
      return instanceStateCache.state;
    }

    try {
      const url = `${process.env.WHATSAPP_EVOLUTION_URL}/instance/connectionState/${process.env.WHATSAPP_EVOLUTION_INSTANCE}`;
      const res = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(5000) });
      const data = await res.json() as { instance?: { state?: string } };
      const state = data.instance?.state ?? "unknown";
      instanceStateCache = { state, ts: Date.now() };
      return state;
    } catch (err) {
      log.error("Evolution API: falha ao verificar estado da instancia", err);
      return "unknown";
    }
  }

  // Tenta enviar uma vez, retorna response + texto bruto
  private async attemptSend(to: string, text: string): Promise<{ response: Response; body: string }> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ number: to, text }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    return { response, body };
  }

  async sendText({ to, text }: SendTextParams): Promise<SendResult> {
    if (!this.envOk()) {
      log.error("EvolutionProvider: variaveis de ambiente ausentes", undefined, {
        WHATSAPP_EVOLUTION_URL:      process.env.WHATSAPP_EVOLUTION_URL      ?? "(ausente)",
        WHATSAPP_EVOLUTION_INSTANCE: process.env.WHATSAPP_EVOLUTION_INSTANCE ?? "(ausente)",
        WHATSAPP_EVOLUTION_KEY:      process.env.WHATSAPP_EVOLUTION_KEY ? "(presente)" : "(ausente)",
      });
      return { success: false, provider: this.name, error: "Variáveis de ambiente não configuradas" };
    }

    // Verificar estado da instância antes de enviar
    const instanceState = await this.checkInstanceState();
    if (instanceState !== "open") {
      log.whatsapp("ALERTA: instancia nao conectada", { state: instanceState, to });
      // Não aborta — Evolution pode reconectar sozinha; tenta enviar mesmo assim
    } else {
      log.whatsapp("instancia conectada", { state: instanceState });
    }

    log.whatsapp("iniciando envio", { to, instance: process.env.WHATSAPP_EVOLUTION_INSTANCE });

    let lastError: string | undefined;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) {
          log.whatsapp(`retry tentativa ${attempt}`, { to });
          await new Promise(r => setTimeout(r, 3000));

          // Revalida estado antes do retry
          instanceStateCache = null;
          const retryState = await this.checkInstanceState();
          log.whatsapp("estado da instancia no retry", { state: retryState });
        }

        const { response, body } = await this.attemptSend(to, text);

        let data: EvolutionResponse = {};
        try { data = JSON.parse(body) as EvolutionResponse; } catch { /* não é JSON */ }

        const deliveryStatus = data.status ?? "unknown";
        const messageId      = data.key?.id;
        const errorMsg       = typeof data.error === "string"
          ? data.error
          : (data.error as Record<string,string>)?.message;

        if (response.ok && deliveryStatus !== "ERROR") {
          log.whatsapp("mensagem aceita pela Evolution", {
            attempt,
            httpStatus:    response.status,
            deliveryStatus,
            descricao:     DELIVERY_STATUS[deliveryStatus] ?? deliveryStatus,
            messageId,
          });

          if (deliveryStatus === "PENDING") {
            log.whatsapp("AVISO: mensagem em PENDING — aguardando Baileys enviar ao servidor", { messageId, to });
          }

          return { success: true, messageId, provider: this.name };
        }

        // HTTP erro ou status ERROR
        lastError = errorMsg ?? `HTTP ${response.status}`;
        log.error(`Evolution API: falha na tentativa ${attempt}`, undefined, {
          httpStatus:    response.status,
          deliveryStatus,
          error:         lastError,
          body:          body.slice(0, 400),
        });

      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        log.error(`Evolution API: excecao na tentativa ${attempt}`, err, { to });
      }
    }

    return { success: false, provider: this.name, error: lastError ?? "Falha ao enviar" };
  }

  async sendTemplate({ to, templateName }: SendTemplateParams): Promise<SendResult> {
    log.whatsapp("template nao suportado, fallback para sendText", { to, templateName });
    return this.sendText({ to, text: `[Template: ${templateName}]` });
  }
}
