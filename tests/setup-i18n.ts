// Unit/integration setup: English (canonical) and Turkish are available synchronously, as the server provides them
// to the app. The browser bundle no longer imports any dictionary statically (V1.11).
import en from "../src/i18n/locales/en.json" with { type: "json" };
import tr from "../src/i18n/locales/tr.json" with { type: "json" };
import { registerDictionary } from "../src/i18n/messages";
registerDictionary("en", en);
registerDictionary("tr", tr);
