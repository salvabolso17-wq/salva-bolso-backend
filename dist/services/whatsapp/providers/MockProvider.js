"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockProvider = void 0;
class MockProvider {
    constructor() {
        this.name = "mock";
    }
    async sendText({ to, text }) {
        const messageId = `mock_${Date.now()}`;
        console.log(`[MockProvider] → ${to}`);
        console.log(`[MockProvider] Mensagem: ${text}`);
        console.log(`[MockProvider] messageId: ${messageId}`);
        return { success: true, messageId, provider: this.name };
    }
    async sendTemplate({ to, templateName, components }) {
        const params = components
            .flatMap((c) => c.parameters)
            .map((p) => p.text)
            .join(", ");
        const messageId = `mock_tpl_${Date.now()}`;
        console.log(`[MockProvider] Template → ${to} | ${templateName} | params: ${params}`);
        return { success: true, messageId, provider: this.name };
    }
}
exports.MockProvider = MockProvider;
