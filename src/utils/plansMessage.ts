import pool from "../db/client";
import { log } from "../utils/logger";

interface PlanInfo {
  nome: string;
  duration_days: number;
  link: string;
  preco: number | null;
}

const PLAN_EMOJI: Record<string, string> = {
  mensal: "💎",
  anual:  "🏆",
};

function parsePrice(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw.replace(",", "."));
  return isNaN(n) ? null : n;
}

function fmtPreco(preco: number): string {
  return "R$" + preco.toFixed(2).replace(".", ",");
}

async function getActivePlans(): Promise<PlanInfo[]> {
  const { rows } = await pool.query<{ nome: string; duration_days: number }>(
    `SELECT nome, duration_days FROM plans WHERE ativo = true ORDER BY duration_days ASC`
  );
  return rows.map(row => ({
    nome:          row.nome,
    duration_days: row.duration_days,
    link:          process.env[`PAYMENT_LINK_${row.nome.toUpperCase()}`] ?? "",
    preco:         parsePrice(process.env[`PLAN_PRICE_${row.nome.toUpperCase()}`]),
  }));
}

// Retorna o bloco formatado com todos os planos ativos, preços e links.
// Retorna string vazia se não houver planos ou links configurados.
export async function buildPlansBlock(): Promise<string> {
  let plans: PlanInfo[];
  try {
    plans = await getActivePlans();
    log.webhook(`[PLANS_LOG] getActivePlans returned ${plans.length} plans:`, { planNames: plans.map(p => p.nome) });
  } catch (err) {
    log.error(`[PLANS_LOG] Error fetching active plans:`, { error: String(err) });
    return "";
  }

  if (plans.length === 0) {
    log.webhook("[PLANS_LOG] No active plans found, returning empty string.", {});
    return "";
  }

  // Calcula economia do plano anual em relação ao mensal
  const mensal = plans.find(p => p.nome === "mensal");
  const anual  = plans.find(p => p.nome === "anual");
  let savingsPct: number | null = null;
  if (mensal?.preco && anual?.preco && mensal.preco > 0) {
    const pct = Math.round((mensal.preco * 12 - anual.preco) / (mensal.preco * 12) * 100);
    if (pct > 0) savingsPct = pct;
  }

  const lines: string[] = ["✨ *Escolha seu Plano Premium:*"];
  
  if (plans.length > 0) {
    lines.push("");
  }

  for (const plan of plans) {
    const emoji = PLAN_EMOJI[plan.nome] ?? "⭐";
    const nome  = plan.nome.charAt(0).toUpperCase() + plan.nome.slice(1);

    let planLine = `${emoji} *Plano ${nome}*`;
    if (plan.preco !== null) {
      planLine += ` — ${fmtPreco(plan.preco)}`;
      if (plan.nome === "anual" && savingsPct !== null) {
        planLine += ` (economize ${savingsPct}%)`;
      }
    }
    lines.push(planLine);
    if (plan.link && plan.preco !== null) {
      const checkoutUrl = `/checkout-premium?plan=${encodeURIComponent(plan.nome)}`;
      const fullUrl = `https://salva-bolso-backend-salvabolso.h5prml.easypanel.host${checkoutUrl}`;
      lines.push(`🚀 Assine agora: ${fullUrl}`);
      log.webhook(`[PLANS_LOG] Generated checkout URL for ${plan.nome}:`, { url: fullUrl });
    } else {
      log.webhook(`[PLANS_LOG] Skipping link for ${plan.nome}:`, { link: plan.link, price: plan.preco });
    }
    lines.push(""); // Add a blank line for separation
  }

  const finalBlock = lines.join("
").trimEnd();
  log.webhook("[PLANS_LOG] Final plans block generated:", { block: finalBlock.slice(0, 200) + '...' }); // Log first 200 chars
  return finalBlock;
}
