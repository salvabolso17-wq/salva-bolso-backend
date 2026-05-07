import type { IWhatsAppProvider, SendTextParams, SendTemplateParams, SendResult } from "../types";

/**
 * Stub para 360dialog WhatsApp API.
 * Variáveis necessárias: WHATSAPP_360_API_KEY
 * Docs: https://docs.360dialog.com/whatsapp-api
 */
export class Dialog360Provider implements IWhatsAppProvider {
  readonly name = "360dialog";

  private readonly baseUrl = "https://waba.360dialog.io/v1/messages";

  async sendText({ to, text }: SendTextParams): Promise<SendResult> {
    if (!process.env.WHATSAPP_360_API_KEY) {
      return { success: false, provider: this.name, error: "WHATSAPP_360_API_KEY não configurado" };
    }

    // Implementação real: descomentar quando configurar as env vars
    // const response = await fetch(this.baseUrl, {
    //   method: "POST",
    //   headers: {
    //     "D360-API-KEY": process.env.WHATSAPP_360_API_KEY!,
    //     "Content-Type": "application/json",
    //   },
    //   body: JSON.stringify({
    //     to,
    //     type: "text",
    //     text: { body: text },
    //   }),
    // });
    // const data = await response.json() as { messages?: Array<{ id: string }> };
    // return { success: response.ok, messageId: data.messages?.[0]?.id, provider: this.name };

    return { success: false, provider: this.name, error: "Dialog360Provider não implementado — configure as variáveis e descomente o código" };
  }

  async sendTemplate({ to, templateName, language, components }: SendTemplateParams): Promise<SendResult> {
    if (!process.env.WHATSAPP_360_API_KEY) {
      return { success: false, provider: this.name, error: "WHATSAPP_360_API_KEY não configurado" };
    }

    // Implementação real: descomentar quando configurar as env vars
    // const response = await fetch(this.baseUrl, {
    //   method: "POST",
    //   headers: {
    //     "D360-API-KEY": process.env.WHATSAPP_360_API_KEY!,
    //     "Content-Type": "application/json",
    //   },
    //   body: JSON.stringify({
    //     to,
    //     type: "template",
    //     template: { namespace: "", name: templateName, language: { policy: "deterministic", code: language }, components },
    //   }),
    // });
    // const data = await response.json() as { messages?: Array<{ id: string }> };
    // return { success: response.ok, messageId: data.messages?.[0]?.id, provider: this.name };

    return { success: false, provider: this.name, error: "Dialog360Provider não implementado — configure as variáveis e descomente o código" };
  }
}
