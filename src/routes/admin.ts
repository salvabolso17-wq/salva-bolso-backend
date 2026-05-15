import { Router } from "express";
import { sendInactivityNotifications } from "../services/notificationService";
import { executarAvisos as executarLembretesAvisos } from "../services/cron/lembretesAvisos";

const router = Router();

function isAuthorized(req: import("express").Request): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  const header = req.headers["x-admin-token"] as string | undefined;
  return header === token;
}

router.post("/cron/inactivity", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, erro: "unauthorized" });
  }
  try {
    const result = await sendInactivityNotifications();
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[ADMIN] /cron/inactivity falhou:", err);
    return res.status(500).json({ ok: false, erro: String(err) });
  }
});

router.post("/cron/lembretes-avisos", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, erro: "unauthorized" });
  }
  try {
    const result = await executarLembretesAvisos();
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[ADMIN] /cron/lembretes-avisos falhou:", err);
    return res.status(500).json({ ok: false, erro: String(err) });
  }
});

export default router;
