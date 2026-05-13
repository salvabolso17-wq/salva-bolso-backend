"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.selfRegisterWebhook = selfRegisterWebhook;
const os = __importStar(require("os"));
const logger_1 = require("../utils/logger");
const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 4000;
// Retorna o IP do container na rede interna do projeto (10.0.x.x preferido)
function getSelfIP() {
    const candidates = [];
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const addr of addrs ?? []) {
            if (addr.family !== "IPv4" || addr.internal)
                continue;
            if (addr.address.startsWith("10.0."))
                candidates.unshift(addr.address);
            else if (addr.address.startsWith("10."))
                candidates.push(addr.address);
            else if (addr.address.startsWith("172."))
                candidates.push(addr.address);
        }
    }
    return candidates[0] ?? null;
}
async function callWebhookSet(webhookUrl) {
    const evolutionUrl = process.env.WHATSAPP_EVOLUTION_URL;
    const evolutionKey = process.env.WHATSAPP_EVOLUTION_KEY;
    const evolutionInstance = process.env.WHATSAPP_EVOLUTION_INSTANCE;
    if (!evolutionUrl || !evolutionKey || !evolutionInstance)
        return false;
    try {
        const resp = await fetch(`${evolutionUrl}/webhook/set/${evolutionInstance}`, {
            method: "POST",
            headers: { apikey: evolutionKey, "Content-Type": "application/json" },
            body: JSON.stringify({
                webhook: {
                    url: webhookUrl,
                    enabled: true,
                    byEvents: false,
                    base64: false,
                    events: ["MESSAGES_UPSERT"],
                },
            }),
            signal: AbortSignal.timeout(8000),
        });
        return resp.ok;
    }
    catch {
        return false;
    }
}
async function selfRegisterWebhook() {
    if (process.env.WHATSAPP_PROVIDER !== "evolution")
        return;
    const port = process.env.PORT ?? "3000";
    const ip = getSelfIP();
    if (!ip) {
        logger_1.log.error("self-register: IP proprio nao detectado", undefined, {});
        return;
    }
    const webhookUrl = `http://${ip}:${port}/webhooks/whatsapp?provider=evolution`;
    logger_1.log.webhook("self-register: iniciando", { ip, port, webhookUrl });
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        const ok = await callWebhookSet(webhookUrl);
        if (ok) {
            logger_1.log.webhook("self-register: webhook registrado", { webhookUrl, attempt });
            return;
        }
        if (attempt < RETRY_ATTEMPTS) {
            logger_1.log.webhook("self-register: aguardando Evolution ficar disponivel", { attempt, retryMs: RETRY_DELAY_MS });
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
    }
    logger_1.log.error("self-register: todas as tentativas falharam", undefined, { webhookUrl, attempts: RETRY_ATTEMPTS });
}
