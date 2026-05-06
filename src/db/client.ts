import { Pool } from "pg";

const pool = new Pool({
  host: "salva-bolso_postgres-salvabolso",
  port: 5432,
  database: "salvabolso",
  user: "admin",
  password: "adminacess@007",
});

export default pool;
