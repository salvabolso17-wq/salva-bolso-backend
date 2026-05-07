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
    const url = this.baseUrl;
    console.log(`[EvolutionProvider] sendText — url=${url} to=${to} WHATSAPP_EVOLUTION_URL=${process.env.WHATSAPP_EVOLUTION_URL} WHATSAPP_EVOLUTION_INSTANCE=${process.env.WHATSAPP_EVOLUTION_INSTANCE} key_set=${!!process.env.WHATSAPP_EVOLUTION_KEY}`);

    if (!process.env.WHATSAPP_EVOLUTION_URL || !process.env.WHATSAPP_EVOLUTION_KEY) {
      console.error("[EvolutionProvider] WHATSAPP_EVOLUTION_URL ou WHATSAPP_EVOLUTION_KEY não configurados");
      return { success: false, provider: this.name, error: "WHATSAPP_EVOLUTION_URL e WHATSAPP_EVOLUTION_KEY não configurados" };
    }

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
      console.log(`[EvolutionProvider] resposta HTTP ${response.status}: ${responseText.slice(0, 300)}`);
      let data: { key?: { id: string }; error?: string } = {};
      try { data = JSON.parse(responseText); } catch { /* não é JSON */ }
      return { success: response.ok, messageId: data.key?.id, provider: this.name };
    } catch (error) {
      console.error("[EvolutionProvider] sendText error:", error);
      return { success: false, provider: this.name, error: "Falha ao enviar mensagem via Evolution API" };
    }
  }

  async sendTemplate({ to, templateName }: SendTemplateParams): Promise<SendResult> {
    // Evolution API não suporta templates nativos do WhatsApp Business
    // Converte para sendText como fallback
    return this.sendText({ to, text: `[Template: ${templateName}]` });
  }
}
