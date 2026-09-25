import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { UserDto, UserRole } from "@mailapp/shared";
import { api, ApiError } from "../lib/api";

interface AuthState {
  user: UserDto | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<UserDto>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  hasRole: (...roles: UserRole[]) => boolean;
  /** true for admin + operator */
  canWrite: boolean;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const res = await api.get<{ user: UserDto }>("/api/auth/me");
      setUser(res.user);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) setUser(null);
      else setUser(null);
    }
  }, []);

  useEffect(() => {
    refreshUser().finally(() => setLoading(false));
  }, [refreshUser]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ user: UserDto }>("/api/auth/login", { email, password });
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/api/auth/logout");
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      login,
      logout,
      refreshUser,
      hasRole: (...roles) => !!user && roles.includes(user.role),
      canWrite: !!user && (user.role === "admin" || user.role === "operator"),
      isAdmin: !!user && user.role === "admin",
    }),
    [user, loading, login, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
