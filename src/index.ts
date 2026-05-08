import "dotenv/config";
import express from "express";
import cors from "cors";
import pool from "./db/client";
import { createTables } from "./database";
import { selfRegisterWebhook } from "./services/webhookSelfRegister";
import usersRoutes from "./routes/users";
import transactionsRoutes from "./routes/transactions";
import authRoutes from "./routes/auth";
import financialGoalsRoutes from "./routes/financial-goals";
import reportsRoutes from "./routes/reports";
import webhooksRoutes from "./routes/webhooks";
import insightsRoutes from "./routes/insights";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/auth", authRoutes);
app.use("/users", usersRoutes);
app.use("/transactions", transactionsRoutes);
app.use("/financial-goals", financialGoalsRoutes);
app.use("/reports", reportsRoutes);
app.use("/webhooks", webhooksRoutes);
app.use("/insights", insightsRoutes);

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

    res.status(500).json({
      error: "Erro ao conectar no banco ❌",
    });
  }
});

const PORT = 80;

(async () => {
  await createTables();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    // Auto-registra webhook na Evolution após a rede overlay estabilizar
    setTimeout(() => selfRegisterWebhook(), 5000);
  });
})();
