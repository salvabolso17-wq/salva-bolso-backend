"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Dialog360Provider = void 0;
/**
 * Stub para 360dialog WhatsApp API.
 * Variáveis necessárias: WHATSAPP_360_API_KEY
 * Docs: https://docs.360dialog.com/whatsapp-api
 */
class Dialog360Provider {
    constructor() {
        this.name = "360dialog";
        this.baseUrl = "https://waba.360dialog.io/v1/messages";
    }
    async sendText({ to, text }) {
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
    async sendTemplate({ to, templateName, language, components }) {
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
exports.Dialog360Provider = Dialog360Provider;
