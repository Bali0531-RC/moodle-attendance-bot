import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PASSKEYS_FILE = path.join(__dirname, '.passkeys.json');

/**
 * Attaches a Chromium CDP Virtual FIDO2/CTAP2 Passkey Authenticator to the given page.
 * - Automatically intercepts any WebAuthn Passkey registration (`navigator.credentials.create`)
 *   and saves the private key to `.passkeys.json`.
 * - Automatically signs any WebAuthn Passkey login challenge (`navigator.credentials.get`)
 *   in 0ms without any OS popup or human interaction (`automaticPresenceSimulation: true, isUserVerified: true`).
 */
export async function attachVirtualPasskeyAuthenticator(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });

    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        ctap2Version: 'ctap2_1',
        transport: 'internal', // Platform authenticator (acts like built-in TouchID / Windows Hello / Android Passkey)
        hasResidentKey: true,  // Supports discoverable Passkeys
        hasUserVerification: true,
        isUserVerified: true,  // Always passes biometric/PIN verification automatically
        automaticPresenceSimulation: true, // Automatically approves without user prompt
      },
    });

    // Load previously saved passkeys from .passkeys.json into this virtual authenticator
    const saved = loadSavedPasskeys();
    let loadedCount = 0;
    for (const cred of saved) {
      try {
        await cdp.send('WebAuthn.addCredential', {
          authenticatorId,
          credential: cred,
        });
        loadedCount++;
      } catch (err) {
        console.warn(`⚠️ [PASSKEY] Nem sikerült betölteni egy mentett kulcsot (${cred.rpId}): ${err.message}`);
      }
    }

    if (loadedCount > 0) {
      console.log(`🔑 [VIRTUAL PASSKEY] ${loadedCount} db mentett Passkey betöltve (.passkeys.json) -> 0ms auto-2FA aktív!`);
    } else {
      console.log('🔑 [VIRTUAL PASSKEY] Virtuális FIDO2 Passkey modul aktív (új Passkey regisztrációra kész)!');
    }

    // Listen for newly registered passkeys and save them immediately
    cdp.on('WebAuthn.credentialAdded', async () => {
      await syncPasskeysToFile(cdp, authenticatorId);
      console.log('🎉 [PASSKEY REGISZTRÁLVA!] Új Passkey sikeresen elkapva és elmentve a .passkeys.json fájlba!');
    });

    cdp.on('WebAuthn.credentialAsserted', () => {
      console.log('⚡ [PASSKEY AUTO-LOGIN] A Facebook/Messenger Passkey 2FA kérést a bot automatikusan aláírta!');
      syncPasskeysToFile(cdp, authenticatorId).catch(() => {});
    });

    return { cdp, authenticatorId, sync: () => syncPasskeysToFile(cdp, authenticatorId) };
  } catch (err) {
    console.warn(`⚠️ [VIRTUAL PASSKEY HIBA] Nem sikerült aktiválni a CDP WebAuthn modult: ${err.message}`);
    return null;
  }
}

export function loadSavedPasskeys() {
  if (!fs.existsSync(PASSKEYS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(PASSKEYS_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function syncPasskeysToFile(cdp, authenticatorId) {
  try {
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    if (Array.isArray(credentials) && credentials.length > 0) {
      fs.writeFileSync(PASSKEYS_FILE, JSON.stringify(credentials, null, 2));
      return credentials;
    }
  } catch (err) {
    console.warn(`⚠️ [PASSKEY MENTÉS HIBA] ${err.message}`);
  }
  return [];
}
