import { log } from "../utils/logger";

export async function buildPlansBlock(): Promise<string> {
  const msg = `🏆 *Anual — R$ 99,90* (R$ 8,32/mês — mais escolhido)
💳 *Mensal — R$ 14,90*

Cancela quando quiser, sem multa.

👉 https://salva-bolso-backend-salvabolso.h5prml.easypanel.host/premium-checkout.html`;

  log.webhook("[PLANS_LOG] Returning static premium checkout message.", {});
  return msg;
}
