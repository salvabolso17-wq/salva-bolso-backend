"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTables = createTables;
const client_1 = __importDefault(require("./db/client"));
async function createTables() {
    try {
        console.log("Tentando conectar no banco...");
        await client_1.default.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telefone VARCHAR(20) UNIQUE NOT NULL,
        nome VARCHAR(100),
        renda NUMERIC(10,2) DEFAULT 0,
        renda_extra NUMERIC(10,2) DEFAULT 0,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
        await client_1.default.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        tipo VARCHAR(20) NOT NULL,
        valor NUMERIC(10,2) NOT NULL,
        categoria VARCHAR(100),
        descricao TEXT,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
        console.log("Tabelas criadas/verificadas ✅");
    }
    catch (error) {
        console.error("ERRO REAL DO BANCO:");
        console.error(error);
    }
}
