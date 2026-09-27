import { he } from "./he";

// i18next init options, used by client/src/main.tsx. one namespace for now
export default {
    resources: { he: { global: he } },
    lng: "he",
    fallbackLng: "he",
    ns: ["global"],
    defaultNS: "global",
    interpolation: { escapeValue: false },
};
