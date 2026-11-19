import { getApp, getApps, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { config } from './config';

let auth: Auth | undefined;

/** The Firebase Auth instance (browser only), connected to the emulator when configured. */
export function firebaseAuth(): Auth {
  if (auth) return auth;
  const app = getApps().length ? getApp() : initializeApp(config.firebase);
  auth = getAuth(app);
  if (config.authEmulatorHost) {
    connectAuthEmulator(auth, `http://${config.authEmulatorHost}`, { disableWarnings: true });
  }
  return auth;
}
