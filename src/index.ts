import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pool from "./db/client";
import { createTables } from "./database";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

createTables();

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

const PORT = process.env.PORT || 80;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
