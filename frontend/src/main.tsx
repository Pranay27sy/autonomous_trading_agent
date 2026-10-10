import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "./styles.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, RouterProvider } from "react-router";
import { ApiError } from "./api";
import { Layout } from "./components/Layout";
import { Empty } from "./components/ui";
import { Alerts } from "./pages/Alerts";
import { Overview } from "./pages/Overview";
import { Trades } from "./pages/Trades";
import { Watchlist } from "./pages/Watchlist";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000, // data only changes on a refresh, which invalidates queries
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

const stockPage = () => import("./pages/Stock").then((m) => ({ Component: m.Stock }));
const researchPage = () => import("./pages/Research").then((m) => ({ Component: m.Research }));

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Overview /> },
      { path: "trades", element: <Trades /> },
      { path: "watchlist", element: <Watchlist /> },
      { path: "research", lazy: researchPage },
      { path: "alerts", element: <Alerts /> },
      // The stock page carries the charting library; load it on first visit.
      { path: "stock", lazy: stockPage },
      { path: "stock/:symbol", lazy: stockPage },
      {
        path: "*",
        element: (
          <Empty title="Page not found">
            <Link className="btn-link" to="/">
              Back to the overview
            </Link>
          </Empty>
        ),
      },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
