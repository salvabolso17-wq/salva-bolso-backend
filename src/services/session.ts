const sessionStore: { [userId: number]: { txCount: number; seenMenuAt: Date | null, lastCommand: string | null, lastContext: string | null } } = {};

export function initSession(userId: number) {
  if (!sessionStore[userId]) {
    sessionStore[userId] = { txCount: 0, seenMenuAt: null, lastCommand: null, lastContext: null };
  }
  return sessionStore[userId];
}

export const getSession = (userId: number) => sessionStore[userId];

export const recordAction = (userId: number, action: string) => {
  if (!sessionStore[userId]) initSession(userId);
  if (action === 'registered_transaction') sessionStore[userId].txCount++;
  if (action === 'showed_menu') sessionStore[userId].seenMenuAt = new Date();
};

export const setLastCommand = (userId: number, command: string) => {
    if (!sessionStore[userId]) initSession(userId);
    sessionStore[userId].lastCommand = command;
};

export const getLastCommand = (userId: number): string | null => sessionStore[userId]?.lastCommand ?? null;

export const setLastContext = (userId: number, context: string) => {
    if (!sessionStore[userId]) initSession(userId);
    sessionStore[userId].lastContext = context;
};

export const getLastContext = (userId: number): string | null => sessionStore[userId]?.lastContext ?? null;

export const canSendInsight = (userId: number): boolean => true; // Placeholder
export const recordInsightSent = (userId: number) => { /* Placeholder */ };
export const setLastInstallment = (userId: number, data: any) => { /* Placeholder */ };
export const getLastInstallment = (userId: number): any => null; // Placeholder
