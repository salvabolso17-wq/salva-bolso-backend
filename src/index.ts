import "dotenv/config";
import express from "express";
import cors from "cors";
import pool from "./db/client";
import { createTables } from "./database";
import usersRoutes from "./routes/users";
import transactionsRoutes from "./routes/transactions";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/users", usersRoutes);
app.use("/transactions", transactionsRoutes);

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
  });
})();
