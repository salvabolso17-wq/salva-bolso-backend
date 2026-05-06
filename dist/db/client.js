"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
const pool = new pg_1.Pool({
    host: "salva-bolso_postgres-salvabolso",
    port: 5432,
    database: "salvabolso",
    user: "admin",
    password: "adminacess@007",
});
exports.default = pool;
