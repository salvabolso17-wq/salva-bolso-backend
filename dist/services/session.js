"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLastInstallment = exports.setLastInstallment = exports.recordInsightSent = exports.canSendInsight = exports.getLastContext = exports.setLastContext = exports.getLastCommand = exports.setLastCommand = exports.recordAction = exports.getSession = void 0;
exports.initSession = initSession;
const sessionStore = {};
function initSession(userId) {
    if (!sessionStore[userId]) {
        sessionStore[userId] = { txCount: 0, seenMenuAt: null, lastCommand: null, lastContext: null };
    }
    return sessionStore[userId];
}
const getSession = (userId) => sessionStore[userId];
exports.getSession = getSession;
const recordAction = (userId, action) => {
    if (!sessionStore[userId])
        initSession(userId);
    if (action === 'registered_transaction')
        sessionStore[userId].txCount++;
    if (action === 'showed_menu')
        sessionStore[userId].seenMenuAt = new Date();
};
exports.recordAction = recordAction;
const setLastCommand = (userId, command) => {
    if (!sessionStore[userId])
        initSession(userId);
    sessionStore[userId].lastCommand = command;
};
exports.setLastCommand = setLastCommand;
const getLastCommand = (userId) => sessionStore[userId]?.lastCommand ?? null;
exports.getLastCommand = getLastCommand;
const setLastContext = (userId, context) => {
    if (!sessionStore[userId])
        initSession(userId);
    sessionStore[userId].lastContext = context;
};
exports.setLastContext = setLastContext;
const getLastContext = (userId) => sessionStore[userId]?.lastContext ?? null;
exports.getLastContext = getLastContext;
const canSendInsight = (userId) => true; // Placeholder
exports.canSendInsight = canSendInsight;
const recordInsightSent = (userId) => { };
exports.recordInsightSent = recordInsightSent;
const setLastInstallment = (userId, data) => { };
exports.setLastInstallment = setLastInstallment;
const getLastInstallment = (userId) => null; // Placeholder
exports.getLastInstallment = getLastInstallment;
