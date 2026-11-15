import * as React from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";

import App from "@/App";
import { I18nProvider } from "@/lib/i18n";
import { RunnerProvider } from "@/lib/store";
import "@/index.css";

const el = document.getElementById("root");
if (!el) throw new Error("找不到 #root");

createRoot(el).render(
  <React.StrictMode>
    <I18nProvider>
        <RunnerProvider>
      <App />
      <Toaster
        position="bottom-right"
        richColors
        closeButton
        toastOptions={{ style: { fontFamily: "inherit" } }}
      />
    </RunnerProvider>
      </I18nProvider>
  </React.StrictMode>,
);
