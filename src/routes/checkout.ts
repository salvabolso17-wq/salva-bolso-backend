import { Router, Request, Response } from "express";

const router = Router();

const ASAAS_API_URL = (process.env.ASAAS_API_URL ?? "https://api.asaas.com/v3").replace(/\/$/, "");
const ASAAS_API_KEY = process.env.ASAAS_API_KEY ?? "";

async function asaasPost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${ASAAS_API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", access_token: ASAAS_API_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function asaasGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${ASAAS_API_URL}${path}`, {
    headers: { access_token: ASAAS_API_KEY },
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

router.post("/criar", async (req: Request, res: Response) => {
  try {
    const { nome, cpf, telefone, email, plano, billingType, creditCard, creditCardHolderInfo } = req.body as {
      nome: string; cpf: string; telefone: string; email: string;
      plano: "mensal" | "anual"; billingType: "PIX" | "BOLETO" | "CREDIT_CARD";
      creditCard?: Record<string, unknown>; creditCardHolderInfo?: Record<string, unknown>;
    };

    // 1. Criar cliente
    const customer = await asaasPost("/customers", {
      name: nome, cpfCnpj: cpf, phone: telefone, email, externalReference: telefone,
    });
    const customerId = customer.id as string;

    // 2. Criar assinatura
    const today = new Date().toISOString().slice(0, 10);
    const subscriptionBody: Record<string, unknown> = {
      customer: customerId,
      billingType,
      value: plano === "mensal" ? 14.90 : 99.90,
      nextDueDate: today,
      cycle: plano === "mensal" ? "MONTHLY" : "YEARLY",
      description: plano === "mensal" ? "padrao_mensal" : "padrao_anual",
      externalReference: telefone,
    };

    if (billingType === "CREDIT_CARD") {
      if (creditCard) subscriptionBody.creditCard = creditCard;
      if (creditCardHolderInfo) subscriptionBody.creditCardHolderInfo = creditCardHolderInfo;
    }

    const sub = await asaasPost("/subscriptions", subscriptionBody);

    if (billingType === "PIX") {
      const paymentsData = await asaasGet(`/subscriptions/${sub.id as string}/payments`);
      const payments = paymentsData.data as Record<string, unknown>[];
      const paymentId = payments[0].id as string;
      const pix = await asaasGet(`/payments/${paymentId}/pixQrCode`);
      return res.json({ pixQrCodeImage: pix.encodedImage, pixQrCodePayload: pix.payload });
    }
    if (billingType === "BOLETO") {
      return res.json({ bankSlipUrl: sub.bankSlipUrl });
    }
    return res.json({ status: sub.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CHECKOUT] erro:", msg);
    res.status(500).json({ erro: msg });
  }
});

export default router;
