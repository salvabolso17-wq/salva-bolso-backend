"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = void 0;
function fields(obj) {
    if (!obj)
        return "";
    return " | " + Object.entries(obj)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join(" | ");
}
function line(tag, msg, extra) {
    return `[${tag.padEnd(8)}] ${new Date().toISOString()} | ${msg}${fields(extra)}`;
}
exports.log = {
    webhook: (msg, extra) => console.log(line("WEBHOOK", msg, extra)),
    user: (msg, extra) => console.log(line("USER", msg, extra)),
    parser: (msg, extra) => console.log(line("PARSER", msg, extra)),
    db: (msg, extra) => console.log(line("DB", msg, extra)),
    whatsapp: (msg, extra) => console.log(line("WHATSAPP", msg, extra)),
    duplicate: (msg, extra) => console.log(line("DUPLICATE", msg, extra)),
    error: (msg, err, extra) => {
        const message = err instanceof Error ? err.message : String(err ?? "");
        const stack = err instanceof Error ? err.stack : undefined;
        console.error(line("ERROR", msg, { ...extra, error: message }));
        if (stack)
            console.error(stack);
    },
};
