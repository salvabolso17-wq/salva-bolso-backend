"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CATEGORIA_EMOJI = exports.MESES_PT = exports.CATEGORIAS_CONHECIDAS = exports.MESES_NOME = void 0;
exports.fmtValor = fmtValor;
exports.capitalizeFirst = capitalizeFirst;
exports.normalizarCategoria = normalizarCategoria;
exports.parseMesExtrato = parseMesExtrato;
function fmtValor(valor) {
    return valor % 1 === 0 ? `R$ ${valor.toFixed(0)}` : `R$ ${valor.toFixed(2)}`;
}
function capitalizeFirst(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
exports.MESES_NOME = ["", "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
exports.CATEGORIAS_CONHECIDAS = [
    "Alimentação", "Transporte", "Moradia", "Lazer", "Saúde",
    "Educação", "Vestuário", "Investimentos", "Receita Extra", "Outros",
];
function normalizarCategoria(input) {
    const lower = input.toLowerCase().trim();
    return exports.CATEGORIAS_CONHECIDAS.find(c => c.toLowerCase() === lower)
        ?? (input.charAt(0).toUpperCase() + input.slice(1).toLowerCase());
}
exports.MESES_PT = {
    janeiro: 1, fevereiro: 2, março: 3, marco: 3, abril: 4, maio: 5, junho: 6,
    julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
    jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
    jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};
function parseMesExtrato(raw) {
    const agora = new Date();
    const texto = raw.toLowerCase().trim();
    // "março/2026" | "3/2026" | "03/26"
    const mAno = texto.match(/^(.+?)\/(\d{2,4})$/);
    if (mAno) {
        let ano = parseInt(mAno[2]);
        if (ano < 100)
            ano += 2000;
        const nome = mAno[1].trim();
        const mes = exports.MESES_PT[nome] ?? (parseInt(nome) || null);
        if (mes && mes >= 1 && mes <= 12)
            return { ano, mes };
    }
    // só nome ou número
    const mes = exports.MESES_PT[texto] ?? (parseInt(texto) || null);
    if (mes && mes >= 1 && mes <= 12)
        return { ano: agora.getFullYear(), mes };
    return null;
}
exports.CATEGORIA_EMOJI = {
    "Alimentação": "🍔",
    "Transporte": "🚗",
    "Moradia": "🏠",
    "Lazer": "🎮",
    "Saúde": "💊",
    "Educação": "📚",
    "Vestuário": "👕",
    "Investimentos": "💰",
    "Receita Extra": "💵",
    "Outros": "📦",
};
