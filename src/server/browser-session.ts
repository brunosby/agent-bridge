import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';

const randomCode = () => randomBytes(18).toString('hex');

export function createBrowserSession(now = Date.now) {
  const openings = new Map<string, number>();
  const redeemed = new Map<string, number>();
  function prune() {
    const time = now();
    for (const codes of [openings, redeemed]) {
      for (const [code, expiry] of codes) {
        if (expiry > time) break;
        codes.delete(code);
      }
    }
  }
  let token = randomCode();
  return {
    get token() {
      return token;
    },
    async inherit(input: Readable) {
      // Read just the credential; the parent may keep this pipe open to signal its lifetime.
      const inherited = await new Promise<string>((resolve, reject) => {
        const finish = () => {
          input.off('readable', read);
          input.off('end', fail);
          input.off('error', fail);
        };
        const fail = () => {
          finish();
          reject(new Error('Missing inherited session'));
        };
        const read = () => {
          const bytes = input.read(36);
          if (bytes === null) return;
          finish();
          resolve(bytes.toString('ascii'));
        };
        input.on('readable', read);
        input.once('end', fail);
        input.once('error', fail);
        read();
      });
      if (!/^[a-f0-9]{36}$/.test(inherited)) throw new Error('Invalid inherited session');
      token = inherited;
    },
    rotate() {
      token = randomCode();
      openings.clear();
    },
    openUrl(port: number) {
      prune();
      const code = randomCode();
      openings.set(code, now() + 60000);
      return 'http://127.0.0.1:' + port + '/#abrir=' + code;
    },
    exchange(code: unknown) {
      prune();
      if (typeof code !== 'string' || !/^[0-9a-f]{36}$/.test(code)) return { status: 403 } as const;
      const digest = createHash('sha256').update(code).digest('hex');
      if (redeemed.has(digest)) return { status: 409 } as const;
      if (!openings.delete(code)) return { status: 403 } as const;
      redeemed.set(digest, now() + 5 * 60000);
      return { status: 200, token } as const;
    },
  };
}

export const browserSession = createBrowserSession();
let bridgePort = 0;
export function setBridgePort(port: number) {
  bridgePort = port;
}

export function requestsBridgeAccess(command: string) {
  if (!bridgePort) return false;
  const local = /(?:localhost|127\.0\.0\.1|\[?::1\]?)/i;
  return local.test(command) && new RegExp('\\b' + bridgePort + '\\b').test(command);
}
