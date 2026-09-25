import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import type { UserRole } from "@mailapp/shared";
import { useAuth } from "../hooks/useAuth";
import { Spinner } from "./ui";

export function ProtectedRoute({ children, roles }: { children: ReactNode; roles?: UserRole[] }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner label="Checking session…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !roles.includes(user.role)) {
    return (
      <div className="card text-sm text-gray-700">
        You do not have permission to view this page.
      </div>
    );
  }
  return <>{children}</>;
}
