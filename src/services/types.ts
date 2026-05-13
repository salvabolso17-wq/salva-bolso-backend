export interface UserRow {
  id: number;
  telefone: string;
  nome: string | null;
  renda: string;
  renda_extra: string;
  subscription_status: string;
  trial_ends_at: Date | null;
  subscription_expires_at: Date | null;
  criado_em: Date | null;
}

export type ProcessResult =
  | { success: true;  userId: number; transacao: Record<string, unknown>; interpretado: Record<string, unknown> }
  | { success: false; userId?: number; erro: string };
