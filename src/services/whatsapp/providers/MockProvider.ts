import type { IWhatsAppProvider, SendTextParams, SendTemplateParams, SendResult } from "../types";

export class MockProvider implements IWhatsAppProvider {
  readonly name = "mock";

  async sendText({ to, text }: SendTextParams): Promise<SendResult> {
    const messageId = `mock_${Date.now()}`;
    console.log(`[MockProvider] → ${to}`);
    console.log(`[MockProvider] Mensagem: ${text}`);
    console.log(`[MockProvider] messageId: ${messageId}`);
    return { success: true, messageId, provider: this.name };
  }

  async sendTemplate({ to, templateName, components }: SendTemplateParams): Promise<SendResult> {
    const params = components
      .flatMap((c) => c.parameters)
      .map((p) => p.text)
      .join(", ");
    const messageId = `mock_tpl_${Date.now()}`;
    console.log(`[MockProvider] Template → ${to} | ${templateName} | params: ${params}`);
    return { success: true, messageId, provider: this.name };
  }
}
