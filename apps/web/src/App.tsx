import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { AuthProvider } from "./hooks/useAuth";
import { ToastProvider } from "./hooks/useToast";
import { Layout } from "./components/Layout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { CampaignsPage } from "./pages/CampaignsPage";
import { CampaignNewPage } from "./pages/CampaignNewPage";
import { CampaignDetailPage } from "./pages/CampaignDetailPage";
import { LeadDetailPage } from "./pages/LeadDetailPage";
import { ReviewPage } from "./pages/ReviewPage";
import { ServicesPage } from "./pages/ServicesPage";
import { InstructionsPage } from "./pages/InstructionsPage";
import { SuppressionsPage } from "./pages/SuppressionsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { UsersPage } from "./pages/UsersPage";
import { AuditPage } from "./pages/AuditPage";
import { SystemPage } from "./pages/SystemPage";
import { ProfilePage } from "./pages/ProfilePage";
import { LandingPagePage } from "./pages/LandingPagePage";

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <AuthProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                element={
                  <ProtectedRoute>
                    <Layout />
                  </ProtectedRoute>
                }
              >
                <Route path="/" element={<DashboardPage />} />
                <Route path="/campaigns" element={<CampaignsPage />} />
                <Route
                  path="/campaigns/new"
                  element={
                    <ProtectedRoute roles={["admin", "operator"]}>
                      <CampaignNewPage />
                    </ProtectedRoute>
                  }
                />
                <Route path="/campaigns/:id" element={<CampaignDetailPage />} />
                <Route path="/leads/:id" element={<LeadDetailPage />} />
                <Route path="/review" element={<ReviewPage />} />
                <Route path="/services" element={<ServicesPage />} />
                <Route path="/services/landing" element={<LandingPagePage />} />
                <Route path="/instructions" element={<InstructionsPage />} />
                <Route path="/suppressions" element={<SuppressionsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route
                  path="/users"
                  element={
                    <ProtectedRoute roles={["admin"]}>
                      <UsersPage />
                    </ProtectedRoute>
                  }
                />
                <Route path="/audit" element={<AuditPage />} />
                <Route path="/system" element={<SystemPage />} />
                <Route path="/profile" element={<ProfilePage />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
