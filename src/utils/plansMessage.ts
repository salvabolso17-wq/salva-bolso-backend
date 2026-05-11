import pool from "../db/client";

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
  } catch {
    return "";
  }

  if (plans.length === 0) return "";

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
      lines.push(`🚀 Assine agora: ${process.env.PUBLIC_URL ?? ''}${checkoutUrl}`);
    }
    lines.push(""); // Add a blank line for separation
  }

  return lines.join("\n").trimEnd();
}
