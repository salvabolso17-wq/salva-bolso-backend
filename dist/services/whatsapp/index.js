"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.whatsapp = void 0;
const MockProvider_1 = require("./providers/MockProvider");
const MetaProvider_1 = require("./providers/MetaProvider");
const EvolutionProvider_1 = require("./providers/EvolutionProvider");
const Dialog360Provider_1 = require("./providers/Dialog360Provider");
function createProvider() {
    const provider = (process.env.WHATSAPP_PROVIDER ?? "mock").toLowerCase();
    switch (provider) {
        case "meta": return new MetaProvider_1.MetaProvider();
        case "evolution": return new EvolutionProvider_1.EvolutionProvider();
        case "360dialog": return new Dialog360Provider_1.Dialog360Provider();
        default: return new MockProvider_1.MockProvider();
    }
}
exports.whatsapp = createProvider();
