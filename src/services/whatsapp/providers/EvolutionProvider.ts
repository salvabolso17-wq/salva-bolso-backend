import type { IWhatsAppProvider, SendTextParams, SendTemplateParams, SendResult } from "../types";

/**
 * Stub para Evolution API (self-hosted).
 * Variáveis necessárias: WHATSAPP_EVOLUTION_URL, WHATSAPP_EVOLUTION_KEY, WHATSAPP_EVOLUTION_INSTANCE
 * Docs: https://doc.evolution-api.com
 */
export class EvolutionProvider implements IWhatsAppProvider {
  readonly name = "evolution";

  private get baseUrl(): string {
    return `${process.env.WHATSAPP_EVOLUTION_URL}/message/sendText/${process.env.WHATSAPP_EVOLUTION_INSTANCE}`;
  }

  async sendText({ to, text }: SendTextParams): Promise<SendResult> {
    if (!process.env.WHATSAPP_EVOLUTION_URL || !process.env.WHATSAPP_EVOLUTION_KEY) {
      return { success: false, provider: this.name, error: "WHATSAPP_EVOLUTION_URL e WHATSAPP_EVOLUTION_KEY não configurados" };
    }

    // Implementação real: descomentar quando configurar as env vars
    // const response = await fetch(this.baseUrl, {
    //   method: "POST",
    //   headers: {
    //     apikey: process.env.WHATSAPP_EVOLUTION_KEY!,
    //     "Content-Type": "application/json",
    //   },
    //   body: JSON.stringify({ number: to, text }),
    // });
    // const data = await response.json() as { key?: { id: string } };
    // return { success: response.ok, messageId: data.key?.id, provider: this.name };

    return { success: false, provider: this.name, error: "EvolutionProvider não implementado — configure as variáveis e descomente o código" };
  }

  async sendTemplate({ to, templateName }: SendTemplateParams): Promise<SendResult> {
    // Evolution API não suporta templates nativos do WhatsApp Business
    // Converte para sendText como fallback
    return this.sendText({ to, text: `[Template: ${templateName}]` });
  }
}
