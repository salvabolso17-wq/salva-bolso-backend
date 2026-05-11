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
import * as fs from 'fs';
import * as path from 'path';

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Serve static files from the 'public' directory
app.use(express.static('public'));

app.use("/auth", authRoutes);
app.use("/users", usersRoutes);
app.use("/transactions", transactionsRoutes);
app.use("/financial-goals", financialGoalsRoutes);
app.use("/reports", reportsRoutes);
app.use("/webhooks", webhooksRoutes);
app.use("/insights", insightsRoutes);
app.use("/healthz/deep", healthDeepRoutes);

// New route for dynamic checkout page
app.get("/checkout-premium", async (req, res) => {
  try {
    const planName = req.query.plan as string;

    if (!planName) {
      return res.status(400).send("Plano não especificado.");
    }

    const upperPlanName = planName.toUpperCase();
    const planPrice = process.env[`PLAN_PRICE_${upperPlanName}`];
    const checkoutLink = process.env[`PAYMENT_LINK_${upperPlanName}`];

    if (!planPrice || !checkoutLink) {
      console.error(`[CHECKOUT] Informações de plano ausentes para: ${planName}`);
      return res.status(404).send("Informações do plano não encontradas.");
    }

    let htmlContent = await fs.promises.readFile(path.join(__dirname, '../public', 'premium-checkout.html'), 'utf8');

    htmlContent = htmlContent.replace(/{{PLAN_NAME}}/g, planName.charAt(0).toUpperCase() + planName.slice(1));
    htmlContent = htmlContent.replace(/{{PLAN_PRICE}}/g, planPrice);
    htmlContent = htmlContent.replace(/{{CHECKOUT_LINK}}/g, checkoutLink);

    res.send(htmlContent);

  } catch (error) {
    console.error("[CHECKOUT ERROR]", error);
    res.status(500).send("Erro ao carregar a página de checkout.");
  }
});

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
