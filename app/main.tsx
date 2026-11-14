import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { registerServiceWorker } from "@/lib/serviceWorker";
import { trackReturns } from "@/lib/refreshOnReturn";
import "./index.css";

// Coming back to the tab refreshes the page's stale queries, but only after a
// real absence; see refreshOnReturn.ts.
const returns = trackReturns();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: () => returns.cameBack() } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

registerServiceWorker();
