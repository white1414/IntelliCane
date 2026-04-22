import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEffect } from "react";
import NotFound from "@/pages/not-found";
import { SmartCaneProvider } from "@/hooks/use-smart-cane";
import { getHost } from "@/lib/settings";

import { Layout } from "@/components/layout";
import Home from "@/pages/home";
import SettingsPage from "@/pages/settings";
import DiagnosticsPage from "@/pages/diagnostics";
import AboutPage from "@/pages/about";

const queryClient = new QueryClient();

// Redirect to settings if no host is configured yet
function RouteGuard() {
  const [location, setLocation] = useLocation();
  
  useEffect(() => {
    // Only check on initial load. We assume localStorage has it, 
    // but the default is 192.168.4.1. If they've literally never saved it, 
    // maybe we just let them stay on home unless it's strictly empty.
    // For now we'll just stay out of the way unless localStorage is empty.
    const h = localStorage.getItem("intellicane.host") ?? localStorage.getItem("smartcane.host");
    if (!h && location === "/") {
      setLocation("/settings");
    }
  }, [location, setLocation]);

  return null;
}

function Router() {
  return (
    <Layout>
      <RouteGuard />
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/diagnostics" component={DiagnosticsPage} />
        <Route path="/about" component={AboutPage} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SmartCaneProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </SmartCaneProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

