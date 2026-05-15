export const cronState = {
  expiracao: {
    registrado: false,
    ultimaExecucao: null as Date | null,
    ultimoExpiredCount: 0,
    erroUltimo: null as string | null,
  },
  notificacoes: {
    registrado: false,
    ultimaExecucao: null as Date | null,
  },
  relatorioSemanal: {
    registrado: false,
    ultimaExecucao: null as Date | null,
  },
  inatividade: {
    registrado: false,
    ultimaExecucao: null as Date | null,
  },
};
