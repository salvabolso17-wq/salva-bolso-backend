"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cronState = void 0;
exports.cronState = {
    expiracao: {
        registrado: false,
        ultimaExecucao: null,
        ultimoExpiredCount: 0,
        erroUltimo: null,
    },
    notificacoes: {
        registrado: false,
        ultimaExecucao: null,
    },
    relatorioSemanal: {
        registrado: false,
        ultimaExecucao: null,
    },
};
