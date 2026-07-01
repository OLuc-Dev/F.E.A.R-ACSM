import { useCallback, useEffect, useState } from "react";

import {
  type AuthUser,
  fetchMe,
  login as loginRequest,
  register as registerRequest,
  setOpenRouterKey as setOpenRouterKeyRequest,
} from "@/lib/api";
import { clearToken, getToken, setToken } from "@/lib/auth";

// Owns the signed-in user: restores the session on load, and exposes sign
// in/up/out plus the BYO OpenRouter key update. `ready` flips true once the
// initial token check settles, so the UI can avoid flashing the login screen.
export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      setReady(true);
      return;
    }
    let active = true;
    fetchMe()
      .then((me) => {
        if (active) setUser(me);
      })
      .catch(() => {
        // Token expired or invalid — drop it and fall back to logged-out.
        clearToken();
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await loginRequest(email, password);
    setToken(result.token);
    setUser(result.user);
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    const result = await registerRequest(email, password);
    setToken(result.token);
    setUser(result.user);
  }, []);

  const signOut = useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  const saveOpenRouterKey = useCallback(async (apiKey: string) => {
    setUser(await setOpenRouterKeyRequest(apiKey));
  }, []);

  return { user, ready, signIn, signUp, signOut, saveOpenRouterKey };
}
