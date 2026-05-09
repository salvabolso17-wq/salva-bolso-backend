import { Router } from "express";
import pool from "../db/client";
import { cronState } from "../utils/cronState";

const router = Router();

const BUILD = "20260509-expiracao-planos";

// Verifica token via header ou query param
function isAuthorized(req: import("express").Request): boolean {
  const token = process.env.HEALTH_TOKEN;
  if (!token) return false; // sem token configurado = bloqueado por padrão
  const header = req.headers["x-health-token"] as string | undefined;
  const query  = req.query["token"] as string | undefined;
  return header === token || query === token;
}

async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number; erro?: string }> {
  const start = Date.now();
  try {
    await pool.query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, erro: String(err) };
  }
}

async function checkPlans(): Promise<{ ok: boolean; planos: { nome: string; duration_days: number; ativo: boolean }[]; erro?: string }> {
  try {
    const r = await pool.query<{ nome: string; duration_days: number; ativo: boolean }>(
      `SELECT nome, duration_days, ativo FROM plans ORDER BY id`
    );
    return { ok: r.rows.length > 0, planos: r.rows };
  } catch (err) {
    return { ok: false, planos: [], erro: String(err) };
  }
}

async function checkColumns(): Promise<{ ok: boolean; colunas: string[] }> {
  try {
    const r = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'users'
         AND column_name IN ('subscription_expires_at', 'current_plan', 'subscription_status', 'trial_ends_at')
       ORDER BY column_name`
    );
    const cols = r.rows.map(row => row.column_name);
    const required = ["current_plan", "subscription_expires_at"];
    const ok = required.every(c => cols.includes(c));
    return { ok, colunas: cols };
  } catch (err) {
    return { ok: false, colunas: [] };
  }
}

async function checkLastAsaas(): Promise<{ ultimoAtivado: string | null; plano: string | null; expiraEm: string | null }> {
  try {
    const r = await pool.query<{ telefone: string; current_plan: string | null; subscription_expires_at: Date | null }>(
      `SELECT telefone, current_plan, subscription_expires_at
       FROM users
       WHERE subscription_status = 'active' AND subscription_expires_at IS NOT NULL
       ORDER BY subscription_expires_at DESC
       LIMIT 1`
    );
    if (r.rows.length === 0) return { ultimoAtivado: null, plano: null, expiraEm: null };
    const row = r.rows[0];
    // Oculta dígitos do meio do telefone
    const tel = row.telefone.replace(/(\d{2})(\d{2})\d+(\d{4})/, "$1$2****$3");
    return {
      ultimoAtivado: tel,
      plano: row.current_plan,
      expiraEm: row.subscription_expires_at?.toISOString() ?? null,
    };
  } catch {
    return { ultimoAtivado: null, plano: null, expiraEm: null };
  }
}

async function checkAssinaturasExpiradas(): Promise<{ total: number }> {
  try {
    const r = await pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM users WHERE subscription_status = 'expired'`
    );
    return { total: parseInt(r.rows[0]?.total ?? "0", 10) };
  } catch {
    return { total: 0 };
  }
}

async function checkEvolution(): Promise<{ ok: boolean; estado?: string; erro?: string }> {
  const url      = process.env.WHATSAPP_EVOLUTION_URL;
  const key      = process.env.WHATSAPP_EVOLUTION_KEY;
  const instance = process.env.WHATSAPP_EVOLUTION_INSTANCE;
  if (!url || !key || !instance) return { ok: false, erro: "env não configurada" };
  try {
    const resp = await fetch(`${url}/instance/connectionState/${instance}`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { ok: false, erro: `HTTP ${resp.status}` };
    const data = await resp.json() as Record<string, unknown>;
    const estado = (data.instance as Record<string, unknown> | undefined)?.state as string ?? String(data.state ?? "desconhecido");
    return { ok: estado === "open", estado };
  } catch (err) {
    return { ok: false, erro: String(err) };
  }
}

async function checkWebhookEvolution(): Promise<{ ok: boolean; url?: string; erro?: string }> {
  const url      = process.env.WHATSAPP_EVOLUTION_URL;
  const key      = process.env.WHATSAPP_EVOLUTION_KEY;
  const instance = process.env.WHATSAPP_EVOLUTION_INSTANCE;
  if (!url || !key || !instance) return { ok: false, erro: "env não configurada" };
  try {
    const resp = await fetch(`${url}/webhook/find/${instance}`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { ok: false, erro: `HTTP ${resp.status}` };
    const data = await resp.json() as Record<string, unknown>;
    const webhookUrl = (data.webhook as Record<string, unknown> | undefined)?.url as string | undefined;
    const enabled    = (data.webhook as Record<string, unknown> | undefined)?.enabled as boolean | undefined;
    return { ok: !!enabled && !!webhookUrl, url: webhookUrl };
  } catch (err) {
    return { ok: false, erro: String(err) };
  }
}

router.get("/", async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ erro: "Não autorizado" });
    return;
  }

  const [db, plans, columns, lastAsaas, expiradas, evolution, webhook] = await Promise.all([
    checkDatabase(),
    checkPlans(),
    checkColumns(),
    checkLastAsaas(),
    checkAssinaturasExpiradas(),
    checkEvolution(),
    checkWebhookEvolution(),
  ]);

  const tudo_ok = db.ok && plans.ok && columns.ok && evolution.ok && webhook.ok;

  res.json({
    status: tudo_ok ? "ok" : "degradado",
    build: BUILD,
    timestamp: new Date().toISOString(),
    checks: {
      banco: { ok: db.ok, latencyMs: db.latencyMs, ...(db.erro ? { erro: db.erro } : {}) },
      plans: { ok: plans.ok, planos: plans.planos, ...(plans.erro ? { erro: plans.erro } : {}) },
      colunas_users: { ok: columns.ok, colunas: columns.colunas },
      cron_expiracao: {
        registrado: cronState.expiracao.registrado,
        ultimaExecucao: cronState.expiracao.ultimaExecucao?.toISOString() ?? null,
        ultimoExpiredCount: cronState.expiracao.ultimoExpiredCount,
        erroUltimo: cronState.expiracao.erroUltimo,
      },
      assinaturas: {
        ultimoAtivado: lastAsaas,
        totalExpiradas: expiradas.total,
      },
      evolution: { ok: evolution.ok, estado: evolution.estado, ...(evolution.erro ? { erro: evolution.erro } : {}) },
      webhook_whatsapp: { ok: webhook.ok, url: webhook.url, ...(webhook.erro ? { erro: webhook.erro } : {}) },
    },
  });
});

export default router;
