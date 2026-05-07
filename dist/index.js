"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const client_1 = __importDefault(require("./db/client"));
const database_1 = require("./database");
const users_1 = __importDefault(require("./routes/users"));
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use("/users", users_1.default);
app.get("/", async (req, res) => {
    try {
        const result = await client_1.default.query("SELECT NOW()");
        res.json({
            message: "Salva Bolso API online 🚀",
            database: "Conectado com sucesso ✅",
            time: result.rows[0],
        });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Erro ao conectar no banco ❌",
        });
    }
});
const PORT = 80;
(async () => {
    await (0, database_1.createTables)();
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`Servidor rodando na porta ${PORT}`);
    });
})();
