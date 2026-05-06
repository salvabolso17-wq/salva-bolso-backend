import pool from "./db/client";

export async function createTables() {
  try {
    console.log("Tentando conectar no banco...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telefone VARCHAR(20) UNIQUE NOT NULL,
        nome VARCHAR(100),
        renda NUMERIC(10,2) DEFAULT 0,
        renda_extra NUMERIC(10,2) DEFAULT 0,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("Tabela users criada/verificada ✅");
  } catch (error) {
    console.error("ERRO REAL DO BANCO:");
    console.error(error);
  }
}
