// Display helpers for the signed-in account and its GitHub connection.

import type { AuthState } from "./store.ts";

/** Who is signed in, for labels: name, else email. */
export function accountLabel(a: AuthState): string {
  return a.user?.name || a.user?.email || "your account";
}

/** The GitHub login when connected, else null. */
export function githubLogin(a: AuthState): string | null {
  return a.github?.connected ? a.github.login : null;
}

/** Avatar to show: the GitHub one when connected, else the sign-in profile picture. */
export function accountAvatar(a: AuthState): string | null {
  return (a.github?.connected ? a.github.avatarUrl : null) || a.user?.avatarUrl || null;
}

/** Signed in, GitHub can be connected, and is not yet. */
export function canConnectGitHub(a: AuthState): boolean {
  return a.authenticated && a.githubEnabled && !a.github?.connected;
}
