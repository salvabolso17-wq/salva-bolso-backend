"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetaProvider = void 0;
/**
 * Stub para Meta WhatsApp Cloud API.
 * Variáveis necessárias: WHATSAPP_META_TOKEN, WHATSAPP_META_PHONE_ID
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */
class MetaProvider {
    constructor() {
        this.name = "meta";
    }
    get baseUrl() {
        const phoneId = process.env.WHATSAPP_META_PHONE_ID;
        return `https://graph.facebook.com/v19.0/${phoneId}/messages`;
    }
    get headers() {
        return {
            Authorization: `Bearer ${process.env.WHATSAPP_META_TOKEN}`,
            "Content-Type": "application/json",
        };
    }
    async sendText({ to, text }) {
        if (!process.env.WHATSAPP_META_TOKEN || !process.env.WHATSAPP_META_PHONE_ID) {
            return { success: false, provider: this.name, error: "WHATSAPP_META_TOKEN e WHATSAPP_META_PHONE_ID não configurados" };
        }
        // Implementação real: descomentar quando configurar as env vars
        // const response = await fetch(this.baseUrl, {
        //   method: "POST",
        //   headers: this.headers,
        //   body: JSON.stringify({
        //     messaging_product: "whatsapp",
        //     to,
        //     type: "text",
        //     text: { body: text },
        //   }),
        // });
        // const data = await response.json() as { messages?: Array<{ id: string }> };
        // return { success: response.ok, messageId: data.messages?.[0]?.id, provider: this.name };
        return { success: false, provider: this.name, error: "MetaProvider não implementado — configure as variáveis e descomente o código" };
    }
    async sendTemplate({ to, templateName, language, components }) {
        if (!process.env.WHATSAPP_META_TOKEN || !process.env.WHATSAPP_META_PHONE_ID) {
            return { success: false, provider: this.name, error: "WHATSAPP_META_TOKEN e WHATSAPP_META_PHONE_ID não configurados" };
        }
        // Implementação real: descomentar quando configurar as env vars
        // const response = await fetch(this.baseUrl, {
        //   method: "POST",
        //   headers: this.headers,
        //   body: JSON.stringify({
        //     messaging_product: "whatsapp",
        //     to,
        //     type: "template",
        //     template: { name: templateName, language: { code: language }, components },
        //   }),
        // });
        // const data = await response.json() as { messages?: Array<{ id: string }> };
        // return { success: response.ok, messageId: data.messages?.[0]?.id, provider: this.name };
        return { success: false, provider: this.name, error: "MetaProvider não implementado — configure as variáveis e descomente o código" };
    }
}
exports.MetaProvider = MetaProvider;
