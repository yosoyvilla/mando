import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { hubClient as defaultHubClient } from "@/lib/hub-client-instance";
import type { HubClient, HubUser } from "@/lib/hub-client";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  user: HubUser | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Gates the app on the hub's cookie session. Checks `client.me()` once on
// mount; 401 means "no session" (unauthenticated), any other outcome means
// "signed in" (authenticated). Accepts an injectable `client` so tests can
// stub the HubClient instead of hitting a real hub.
export function AuthProvider({
  children,
  client = defaultHubClient,
}: {
  children: React.ReactNode;
  client?: HubClient;
}) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<HubUser | null>(null);

  const refresh = useCallback(async () => {
    setStatus("loading");
    try {
      const me = await client.me();
      setUser(me);
      setStatus(me ? "authenticated" : "unauthenticated");
    } catch {
      setUser(null);
      setStatus("unauthenticated");
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const { user: loggedInUser } = await client.login(email, password);
      setUser(loggedInUser);
      setStatus("authenticated");
    },
    [client],
  );

  const logout = useCallback(async () => {
    await client.logout();
    setUser(null);
    setStatus("unauthenticated");
  }, [client]);

  return (
    <AuthContext.Provider value={{ status, user, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
