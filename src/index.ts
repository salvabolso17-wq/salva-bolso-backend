import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import pool from "./db/client";
import { createTables } from "./database";
import { selfRegisterWebhook } from "./services/webhookSelfRegister";
import { runDailyNotifications, runWeeklyNotifications } from "./services/notificationService";
import { cronState } from "./utils/cronState";
import usersRoutes from "./routes/users";
import transactionsRoutes from "./routes/transactions";
import authRoutes from "./routes/auth";
import financialGoalsRoutes from "./routes/financial-goals";
import reportsRoutes from "./routes/reports";
import webhooksRoutes from "./routes/webhooks";
import insightsRoutes from "./routes/insights";
import healthDeepRoutes from "./routes/healthDeep";
import * as path from 'path';
import { whatsapp } from "./services/whatsapp";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, '../public')));

app.use("/auth", authRoutes);
app.use("/users", usersRoutes);
app.use("/transactions", transactionsRoutes);
app.use("/financial-goals", financialGoalsRoutes);
app.use("/reports", reportsRoutes);
app.use("/webhooks", webhooksRoutes);
app.use("/insights", insightsRoutes);
app.use("/healthz/deep", healthDeepRoutes);

// Global error handler — catches sync throws and next(err) calls
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[GLOBAL ERROR]", err);
  res.status(200).json({ received: true });
});

// Health check sem dependência de banco — para validar que o proxy alcança o container
app.get("/healthz", (_req, res) => {
  res.status(200).send("ok");
});

app.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      message: "Salva Bolso API online 🚀",
      database: "Conectado com sucesso ✅",
      time: result.rows[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao conectar no banco ❌" });
  }
});

app.get("/test/lembrete-contas", async (_req, res) => {
  const { rows } = await pool.query<{ id: number; telefone: string }>(
    `SELECT id, telefone FROM users
     WHERE RIGHT(REGEXP_REPLACE(telefone,'[^0-9]','','g'),8) = '92044696'`
  );
  for (const user of rows) {
    const recRows = await pool.query<{ nome: string; valor: string }>(
      `SELECT nome, valor FROM recurring_expenses WHERE user_id = $1 AND ativo = TRUE ORDER BY valor DESC`,
      [user.id]
    );
    const total = recRows.rows.reduce((s, r) => s + Number(r.valor), 0);
    const lista = recRows.rows.map((r: { nome: string; valor: string }) => `• ${r.nome} — R$ ${Number(r.valor).toFixed(2)}`).join("\n");
    await whatsapp.sendText({
      to: user.telefone,
      text: ["📅 Suas contas deste mês:", "", lista, "", `Total: R$ ${total.toFixed(2)}`].join("\n"),
    });
  }
  res.json({ ok: true });
});

const PORT = Number(process.env.PORT ?? 3000);

(async () => {
  await createTables();
  console.log(`[STARTUP] tentando ouvir em 0.0.0.0:${PORT} | build=20260509-producao-publica`);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[STARTUP] Servidor ouvindo em 0.0.0.0:${PORT}`);
    // Auto-registra webhook na Evolution após a rede overlay estabilizar
    setTimeout(() => selfRegisterWebhook(), 5000);
    // Expiração de assinaturas — a cada hora
    cronState.expiracao.registrado = true;
    cron.schedule("0 * * * *", async () => {
      cronState.expiracao.ultimaExecucao = new Date();
      cronState.expiracao.erroUltimo = null;
      try {
        const r = await pool.query(
          `UPDATE users SET subscription_status = 'expired'
           WHERE subscription_status = 'active'
             AND subscription_expires_at IS NOT NULL
             AND subscription_expires_at < NOW()`
        );
        cronState.expiracao.ultimoExpiredCount = r.rowCount ?? 0;
        if ((r.rowCount ?? 0) > 0) {
          console.log(`[CRON] ${r.rowCount} assinatura(s) expirada(s)`);
        }
      } catch (err) {
        cronState.expiracao.erroUltimo = String(err);
        console.error("[CRON] falha na expiracao de assinaturas:", err);
      }
      // Migra trial vencido para expired — mantém banco consistente
      try {
        const t = await pool.query(
          `UPDATE users SET subscription_status = 'expired'
           WHERE subscription_status = 'trial'
             AND trial_ends_at IS NOT NULL
             AND trial_ends_at < NOW()`
        );
        if ((t.rowCount ?? 0) > 0) {
          console.log(`[CRON] ${t.rowCount} trial(s) expirado(s)`);
        }
      } catch (err) {
        console.error("[CRON] falha na expiracao de trials:", err);
      }
    });

    // Notificações de retenção — diariamente às 9h horário de Brasília
    cronState.notificacoes.registrado = true;
    cron.schedule("0 9 * * *", () => {
      cronState.notificacoes.ultimaExecucao = new Date();
      runDailyNotifications().catch(err => console.error("cron diario falhou:", err));
    }, { timezone: "America/Sao_Paulo" });

    // Push semanal comparativo — segunda-feira 9h Brasília
    cronState.relatorioSemanal.registrado = true;
    cron.schedule("0 9 * * 1", () => {
      cronState.relatorioSemanal.ultimaExecucao = new Date();
      runWeeklyNotifications().catch(err => console.error("cron semanal falhou:", err));
    }, { timezone: "America/Sao_Paulo" });
  });
})();
