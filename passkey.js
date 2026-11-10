import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PASSKEYS_FILE = path.join(__dirname, '.passkeys.json');

const attachedPages = new WeakSet();
const activeAdapters = [];

/**
 * Attaches a Chromium CDP Virtual FIDO2/CTAP2 Passkey Authenticator to a Page (and automatically to any new tabs opened in the Context).
 * - Automatically intercepts any WebAuthn Passkey registration (`navigator.credentials.create`)
 *   and saves the private key to `.passkeys.json`.
 * - Automatically signs any WebAuthn Passkey login challenge (`navigator.credentials.get`)
 *   in 0ms without any OS popup or human interaction (`automaticPresenceSimulation: true, isUserVerified: true`).
 */
export async function attachVirtualPasskeyToPage(page) {
  if (attachedPages.has(page)) return;
  attachedPages.add(page);

  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });

    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        ctap2Version: 'ctap2_1',
        transport: 'internal', // Platform authenticator (TouchID / Windows Hello / Built-in Passkey)
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });

    const saved = loadSavedPasskeys();
    for (const cred of saved) {
      // Add for the original rpId (e.g. accounts.meta.com) AND also clone for facebook.com & messenger.com
      // in case Messenger/Facebook prompts WebAuthn directly on their own domain!
      const domainsToRegister = new Set([cred.rpId, 'facebook.com', 'messenger.com'].filter(Boolean));
      for (const rpId of domainsToRegister) {
        try {
          await cdp.send('WebAuthn.addCredential', {
            authenticatorId,
            credential: { ...cred, rpId },
          });
        } catch {}
      }
    }

    cdp.on('WebAuthn.credentialAdded', async () => {
      await syncPasskeysToFile(cdp, authenticatorId);
      console.log('🎉 [PASSKEY REGISZTRÁLVA!] Új Passkey sikeresen elkapva és elmentve a .passkeys.json fájlba!');
    });

    cdp.on('WebAuthn.credentialAsserted', () => {
      console.log('⚡ [PASSKEY AUTO-LOGIN] A Facebook/Messenger Passkey 2FA kérést a bot automatikusan aláírta!');
      syncPasskeysToFile(cdp, authenticatorId).catch(() => {});
    });

    activeAdapters.push({ cdp, authenticatorId });
    return { cdp, authenticatorId };
  } catch (err) {
    console.warn(`⚠️ [VIRTUAL PASSKEY HIBA] Nem sikerült aktiválni a CDP WebAuthn modult: ${err.message}`);
    return null;
  }
}

export async function attachVirtualPasskeyAuthenticator(contextOrPage) {
  const context = typeof contextOrPage.pages === 'function' ? contextOrPage : contextOrPage.context();

  // Attach to all currently open tabs
  for (const p of context.pages()) {
    await attachVirtualPasskeyToPage(p);
  }

  // Automatically attach to any newly opened tab / popup!
  context.on('page', (newPage) => {
    attachVirtualPasskeyToPage(newPage).catch(() => {});
  });

  const saved = loadSavedPasskeys();
  if (saved.length > 0) {
    console.log(
      `🔑 [VIRTUAL PASSKEY] ${saved.length} db mentett Passkey betöltve minden fülre (.passkeys.json) -> 0ms auto-2FA aktív!`
    );
  } else {
    console.log('🔑 [VIRTUAL PASSKEY] Virtuális FIDO2 Passkey modul aktív minden fülön (új Passkey regisztrációra kész)!');
  }

  return {
    sync: async () => {
      for (const { cdp, authenticatorId } of activeAdapters) {
        await syncPasskeysToFile(cdp, authenticatorId);
      }
    },
  };
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
      // Merge with existing by credentialId
      const existing = loadSavedPasskeys();
      const map = new Map(existing.map((c) => [c.credentialId, c]));
      for (const c of credentials) {
        map.set(c.credentialId, c);
      }
      const merged = [...map.values()];
      fs.writeFileSync(PASSKEYS_FILE, JSON.stringify(merged, null, 2));
      return merged;
    }
  } catch {}
  return [];
}
