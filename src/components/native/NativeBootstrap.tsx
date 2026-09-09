"use client";

import { useEffect } from "react";
import { isNativeApp } from "@/lib/platform";
import { installNativeFetchHeader } from "@/lib/nativeFetch";
import { configurePurchases, logOutPurchases } from "@/lib/iap";
import { registerNativePush } from "@/lib/native/push";
import { useNativeAppListeners } from "@/lib/native/useNativeAppListeners";
import NativeOfflineScreen from "@/components/native/NativeOfflineScreen";
import { createClient } from "@/lib/supabase/client";

// =============================================================================
// One mount point for every native-only side effect (2026-09-07,
// appstore-execute): the X-OakTend-Client fetch header, RevenueCat
// configuration, native push registration, and the app-lifecycle listeners
// (deep links, Android back button, resume-refresh). Everything inside is a
// no-op on web - isNativeApp() gates each one - so this is safe to mount
// unconditionally at the root of the app.
//
// Mounted once in src/app/layout.tsx, next to StaleDeployRecovery (the
// existing "no visible UI, runs global side effects" component this file
// follows the same shape as).
// =============================================================================
export default function NativeBootstrap() {
  useNativeAppListeners();

  useEffect(() => {
    if (!isNativeApp()) return;
    installNativeFetchHeader();

    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (cancelled || !user) return;

      await configurePurchases(user.id);

      // Which side of the marketplace this session is on, mirroring
      // PushRegistrar.tsx's own side detection: a contractor row present
      // means "pro", otherwise "homeowner". Best-effort - a failed lookup
      // just registers with side: null, which native_push_tokens allows
      // (nullable column, same as push_subscriptions).
      let side: "homeowner" | "pro" | null = null;
      try {
        const { data: contractor } = await supabase
          .from("contractors")
          .select("id")
          .eq("user_id", user.id)
          .maybeSingle();
        side = contractor ? "pro" : "homeowner";
      } catch {
        // Leave side null.
      }
      await registerNativePush(side);
    })();

    // ACCOUNT SWITCH ON ONE DEVICE. This effect runs once (the root layout
    // never unmounts across in-app navigation), so without this listener a
    // sign-out followed by a different sign-in would leave RevenueCat still
    // configured with the FIRST account's app_user_id - and the webhook writes
    // subscriptions.user_id straight from that id, so the second person's
    // purchase would land on the first person's row. Re-point the SDK on every
    // session change instead.
    const supabase = createClient();
    const { data: authSub } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === "SIGNED_OUT" || !session?.user) {
          void logOutPurchases();
          return;
        }
        if (event === "SIGNED_IN" || event === "USER_UPDATED") {
          void configurePurchases(session.user.id);
        }
      }
    );

    return () => {
      cancelled = true;
      authSub?.subscription?.unsubscribe();
    };
  }, []);

  return <NativeOfflineScreen />;
}
