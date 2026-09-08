// 浏览器端 Ed25519 设备身份：生成、持久化（localStorage）、签名。
// gateway 侧规则：deviceId = sha256(32 字节原始公钥).hex，签名 base64url。
import type { GatewayBrowserDeviceIdentity, GatewayBrowserDeviceTokenRecord, GatewayBrowserDeviceTokenStore } from "@openclaw/gateway-client/browser";

const IDENTITY_KEY = "rana-web.device-identity";
const tokenKey = (clientId: string, deviceId: string, role: string) =>
  `rana-web.device-token.${clientId}.${role}.${deviceId}`;

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface StoredIdentity {
  deviceId: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

async function generateIdentity(): Promise<StoredIdentity> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const deviceId = [...new Uint8Array(await crypto.subtle.digest("SHA-256", rawPub))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const stored: StoredIdentity = { deviceId, publicJwk, privateJwk };
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(stored));
  return stored;
}

async function loadStoredIdentity(): Promise<StoredIdentity | null> {
  const raw = localStorage.getItem(IDENTITY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredIdentity;
    const priv = await crypto.subtle.importKey("jwk", parsed.privateJwk, "Ed25519", true, ["sign"]);
    const pub = await crypto.subtle.importKey("jwk", parsed.publicJwk, "Ed25519", true, ["verify"]);
    return { ...parsed, privateJwk: parsed.privateJwk, publicJwk: parsed.publicJwk, __priv: priv, __pub: pub } as StoredIdentity & { __priv: CryptoKey; __pub: CryptoKey };
  } catch {
    return null;
  }
}

let cached: GatewayBrowserDeviceIdentity | null | undefined;

/** SDK 依赖：加载（或首次生成）浏览器设备身份。Ed25519 不可用时返回 null（配对将受限）。 */
export function loadBrowserIdentity(): Promise<GatewayBrowserDeviceIdentity | null> {
  if (cached !== undefined) return Promise.resolve(cached);
  return (async () => {
    try {
      const stored = (await loadStoredIdentity()) ?? (await generateIdentity());
      const priv = await crypto.subtle.importKey("jwk", stored.privateJwk, "Ed25519", true, ["sign"]);
      const pub = await crypto.subtle.importKey("jwk", stored.publicJwk, "Ed25519", true, ["verify"]);
      const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pub));
      const publicKey = toBase64Url(rawPub);
      cached = {
        deviceId: stored.deviceId,
        publicKey,
        sign: async (payload: string) => {
          const sig = await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(payload));
          return toBase64Url(new Uint8Array(sig));
        },
      };
      return cached;
    } catch (e) {
      console.warn("[rana-web] Ed25519 身份不可用，将以无设备身份连接:", e);
      cached = null;
      return cached;
    }
  })();
}

/** SDK 依赖：hello-ok.auth.deviceToken 的持久化存储。 */
export const browserTokenStore: GatewayBrowserDeviceTokenStore = {
  async load({ clientId, deviceId, role }): Promise<GatewayBrowserDeviceTokenRecord | null> {
    const raw = localStorage.getItem(tokenKey(clientId, deviceId, role));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as GatewayBrowserDeviceTokenRecord;
    } catch {
      return null;
    }
  },
  async store({ clientId, deviceId, role, token, scopes }) {
    localStorage.setItem(tokenKey(clientId, deviceId, role), JSON.stringify({ token, scopes }));
  },
  async clear({ clientId, deviceId, role }) {
    localStorage.removeItem(tokenKey(clientId, deviceId, role));
  },
};
