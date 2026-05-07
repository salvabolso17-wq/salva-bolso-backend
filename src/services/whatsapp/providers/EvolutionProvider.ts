import type { IWhatsAppProvider, SendTextParams, SendTemplateParams, SendResult } from "../types";
import { log } from "../../../utils/logger";

/**
 * Evolution API (self-hosted).
 * Env: WHATSAPP_EVOLUTION_URL, WHATSAPP_EVOLUTION_KEY, WHATSAPP_EVOLUTION_INSTANCE
 * Docs: https://doc.evolution-api.com
 */
export class EvolutionProvider implements IWhatsAppProvider {
  readonly name = "evolution";

  private get sendUrl(): string {
    return `${process.env.WHATSAPP_EVOLUTION_URL}/message/sendText/${process.env.WHATSAPP_EVOLUTION_INSTANCE}`;
  }

  async sendText({ to, text }: SendTextParams): Promise<SendResult> {
    if (!process.env.WHATSAPP_EVOLUTION_URL || !process.env.WHATSAPP_EVOLUTION_KEY || !process.env.WHATSAPP_EVOLUTION_INSTANCE) {
      log.error("EvolutionProvider: variaveis de ambiente ausentes", undefined, {
        url:      process.env.WHATSAPP_EVOLUTION_URL      ?? "(ausente)",
        instance: process.env.WHATSAPP_EVOLUTION_INSTANCE ?? "(ausente)",
        key:      process.env.WHATSAPP_EVOLUTION_KEY      ? "(presente)" : "(ausente)",
      });
      return { success: false, provider: this.name, error: "Variáveis de ambiente não configuradas" };
    }

    log.whatsapp("enviando mensagem", { to, instance: process.env.WHATSAPP_EVOLUTION_INSTANCE });

    try {
      const response = await fetch(this.sendUrl, {
        method: "POST",
        headers: {
          apikey: process.env.WHATSAPP_EVOLUTION_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ number: to, text }),
      });

      const responseText = await response.text();
      let data: { key?: { id?: string }; status?: string; error?: string } = {};
      try { data = JSON.parse(responseText); } catch { /* não é JSON */ }

      if (response.ok) {
        log.whatsapp("mensagem enviada", {
          httpStatus:    response.status,
          deliveryStatus: data.status ?? "unknown",
          messageId:     data.key?.id,
        });
        return { success: true, messageId: data.key?.id, provider: this.name };
      }

      log.error("Evolution API: erro no envio", undefined, {
        httpStatus: response.status,
        body:       responseText.slice(0, 300),
      });
      return { success: false, provider: this.name, error: `HTTP ${response.status}` };

    } catch (err) {
      log.error("Evolution API: excecao no envio", err, { to });
      return { success: false, provider: this.name, error: "Falha na requisição para Evolution API" };
    }
  }

  async sendTemplate({ to, templateName }: SendTemplateParams): Promise<SendResult> {
    return this.sendText({ to, text: `[Template: ${templateName}]` });
  }
}
