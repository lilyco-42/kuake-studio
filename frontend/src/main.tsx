import * as React from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";

import App from "@/App";
import { RunnerProvider } from "@/lib/store";
import "@/index.css";

const el = document.getElementById("root");
if (!el) throw new Error("找不到 #root");

createRoot(el).render(
  <React.StrictMode>
    <RunnerProvider>
      <App />
      <Toaster
        position="bottom-right"
        richColors
        closeButton
        toastOptions={{ style: { fontFamily: "inherit" } }}
      />
    </RunnerProvider>
  </React.StrictMode>,
);
