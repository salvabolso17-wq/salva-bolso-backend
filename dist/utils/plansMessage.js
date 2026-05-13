"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPlansBlock = buildPlansBlock;
const logger_1 = require("../utils/logger");
async function buildPlansBlock() {
    const msg = `✨ *Seu período grátis terminou.*

Continue usando o Salva Bolso Premium para manter:
• controle financeiro completo
• metas e relatórios
• organização automática no WhatsApp

Escolha seu plano:
https://salva-bolso-backend-salvabolso.h5prml.easypanel.host/premium-checkout.html`;
    logger_1.log.webhook("[PLANS_LOG] Returning static premium checkout message.", {});
    return msg;
}
