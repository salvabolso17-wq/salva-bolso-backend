import type { IWhatsAppProvider, SendTextParams, SendTemplateParams, SendResult } from "../types";
import { log } from "../../../utils/logger";

/**
 * Evolution API (self-hosted).
 * Env: WHATSAPP_EVOLUTION_URL, WHATSAPP_EVOLUTION_KEY, WHATSAPP_EVOLUTION_INSTANCE
 * Docs: https://doc.evolution-api.com
 */
export class EvolutionProvider implements IWhatsAppProvider {
  readonly name = "evolution";

  private get baseUrl(): string {
    return `${process.env.WHATSAPP_EVOLUTION_URL}/message/sendText/${process.env.WHATSAPP_EVOLUTION_INSTANCE}`;
  }

  async sendText({ to, text }: SendTextParams): Promise<SendResult> {
    const url = this.baseUrl;

    if (!process.env.WHATSAPP_EVOLUTION_URL || !process.env.WHATSAPP_EVOLUTION_KEY || !process.env.WHATSAPP_EVOLUTION_INSTANCE) {
      log.error("EvolutionProvider: variaveis de ambiente nao configuradas", undefined, {
        WHATSAPP_EVOLUTION_URL:      process.env.WHATSAPP_EVOLUTION_URL      ?? "(ausente)",
        WHATSAPP_EVOLUTION_INSTANCE: process.env.WHATSAPP_EVOLUTION_INSTANCE ?? "(ausente)",
        WHATSAPP_EVOLUTION_KEY:      process.env.WHATSAPP_EVOLUTION_KEY      ? "(presente)" : "(ausente)",
      });
      return { success: false, provider: this.name, error: "Variáveis de ambiente da Evolution não configuradas" };
    }

    log.whatsapp("enviando via Evolution API", { url, to });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          apikey: process.env.WHATSAPP_EVOLUTION_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ number: to, text }),
      });

      const responseText = await response.text();
      let data: { key?: { id: string }; error?: string } = {};
      try { data = JSON.parse(responseText); } catch { /* não é JSON */ }

      if (response.ok) {
        log.whatsapp("Evolution API: sucesso", { status: response.status, messageId: data.key?.id });
      } else {
        log.error("Evolution API: resposta de erro", undefined, {
          status: response.status,
          body:   responseText.slice(0, 300),
        });
      }

      return { success: response.ok, messageId: data.key?.id, provider: this.name };
    } catch (err) {
      log.error("Evolution API: excecao na requisicao", err, { url, to });
      return { success: false, provider: this.name, error: "Falha na requisição para Evolution API" };
    }
  }

  async sendTemplate({ to, templateName }: SendTemplateParams): Promise<SendResult> {
    log.whatsapp("template nao suportado, usando sendText como fallback", { to, templateName });
    return this.sendText({ to, text: `[Template: ${templateName}]` });
  }
}
