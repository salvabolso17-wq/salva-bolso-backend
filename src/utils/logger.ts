type Tag = "WEBHOOK" | "USER" | "PARSER" | "DB" | "WHATSAPP" | "ERROR" | "DUPLICATE";

function fields(obj?: Record<string, unknown>): string {
  if (!obj) return "";
  return " | " + Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" | ");
}

function line(tag: Tag, msg: string, extra?: Record<string, unknown>): string {
  return `[${tag.padEnd(8)}] ${new Date().toISOString()} | ${msg}${fields(extra)}`;
}

export const log = {
  webhook:  (msg: string, extra?: Record<string, unknown>) => console.log(line("WEBHOOK", msg, extra)),
  user:     (msg: string, extra?: Record<string, unknown>) => console.log(line("USER", msg, extra)),
  parser:   (msg: string, extra?: Record<string, unknown>) => console.log(line("PARSER", msg, extra)),
  db:       (msg: string, extra?: Record<string, unknown>) => console.log(line("DB", msg, extra)),
  whatsapp: (msg: string, extra?: Record<string, unknown>) => console.log(line("WHATSAPP", msg, extra)),
  duplicate: (msg: string, extra?: Record<string, unknown>) => console.log(line("DUPLICATE", msg, extra)),
  error:    (msg: string, err?: unknown, extra?: Record<string, unknown>) => {
    const message = err instanceof Error ? err.message : String(err ?? "");
    const stack   = err instanceof Error ? err.stack   : undefined;
    console.error(line("ERROR", msg, { ...extra, error: message }));
    if (stack) console.error(stack);
  },
};
