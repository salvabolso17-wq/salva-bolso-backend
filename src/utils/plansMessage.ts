import { log } from "../utils/logger";

export async function buildPlansBlock(): Promise<string> {
  const msg = `✨ *Seu período grátis terminou.*

Continue usando o Salva Bolso Premium para manter:
• controle financeiro completo
• metas e relatórios
• organização automática no WhatsApp

Escolha seu plano:
https://salva-bolso-backend-salvabolso.h5prml.easypanel.host/premium-checkout.html`;

  log.webhook("[PLANS_LOG] Returning static premium checkout message.", {});
  return msg;
}
