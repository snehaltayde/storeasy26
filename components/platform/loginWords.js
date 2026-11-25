// Phase 3 line 0: the words of the operator sign-in. Pure (no React, no
// node:*), so scripts/test-platform-shell.js checks them.

export const LOGIN = Object.freeze({
  title: "Storeasy platform",
  intro: "Sign in to run every store.",
  email: "Operator email",
  emailHint: "First setup with no operator account yet? Leave it empty and use the setup password.",
  password: "Password",
  totp: "Authenticator code",
  totpHint: "The 6 digits your authenticator app shows now.",
  submit: "Sign in",
  busy: "Signing in…",
  enrollTitle: "Add Storeasy to your authenticator app",
  enrollBody: "In your authenticator app, add an account by typing in this key. Then enter the 6-digit code it shows and press Sign in again.",
  enrollKey: "Authenticator key",
  enrollOnce: "We show this key once. Add it now: it can't be shown again.",
  enrollLink: "Or copy the setup link, if your app takes one",
  notConfiguredTitle: "The operator console isn't set up yet",
  notConfiguredBody: "Set PLATFORM_ADMIN_PASSWORD in the server's environment, then reload this page.",
});

// The server's answer, in plain words: what went wrong and what to do next.
export function loginError(status, error = "") {
  const e = String(error || "");
  if (status === 429) return "Too many tries. Wait 15 minutes, then try again.";
  if (status === 503) return LOGIN.notConfiguredBody;
  if (status === 403) return "This sign-in came from another site, so we refused it. Open the console's own address and sign in there.";
  if (status === 400) return "Enter your password.";
  if (/didn't match|Wrong authenticator code/i.test(e)) return "That code didn't work. Codes change every 30 seconds: enter the one your app shows now.";
  if (/code required/i.test(e)) return "Enter the 6-digit code from your authenticator app.";
  if (/Wrong email or password/i.test(e)) return "That email and password don't match an operator account.";
  if (/operator email, password and code/i.test(e)) return "The setup password is switched off now that operator accounts exist. Sign in with your email, password and code.";
  if (/Wrong password/i.test(e)) return "That isn't the setup password.";
  if (status === 401) return "We couldn't sign you in. Check your details and try again.";
  return "Something went wrong on our side. Try again in a minute.";
}
