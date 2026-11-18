# Firebase Authentication for sign-in

Firebase Authentication (email and password) handles credentials: password storage, sign-in, token refresh, password reset and brute-force protection. The frontend signs in with the Firebase client SDK and sends the Firebase ID token to the API gateway, which verifies it with the Admin SDK (including revocation) and forwards `X-User-Id` and `X-User-Role` as before.

The Identity service still owns everything that is ours: each user's single **role**, stored as a Firebase custom claim; **Invitations** (our own single-use, 7-day, revocable token, BR-AU-02; accepting it sets the password through the Admin SDK); and Tutor administration, where disabling a Tutor disables the Firebase user and revokes their refresh tokens.

We rejected keeping our own password hashing and RS256 JWT issuing: it is security-critical code that Firebase already does better, and it would consume time better spent on the business services.

## Consequences

- The token rules in `docs/01-nghiep-vu.md` §3.1 change: ID tokens last 1 hour and refresh is handled by the Firebase SDK (no 15-minute / 7-day rotation of our own), and the "5 failed logins lock 15 minutes" rule is replaced by Firebase's built-in abuse protection.
- Identity no longer has `password_hash` or `refresh_tokens`; it no longer serves a JWKS.
- A role change takes effect when the user's ID token next refreshes (up to 1 hour) unless Identity revokes their tokens, which it does on every role change and disable.
- Local development uses the Auth emulator.
