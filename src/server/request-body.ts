import type { Readable } from 'node:stream';

export class BodyTooLargeError extends Error {}

export function readJson(req: Readable): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const append = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        chunks.length = 0;
        req.off('data', append);
        req.off('end', parse);
        reject(new BodyTooLargeError('body too large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const parse = () => {
      try {
        resolve(bytes ? JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) : {});
      } catch (error) {
        reject(error);
      }
    };
    req.once('error', reject);
    req.once('end', parse);
    req.on('data', append);
  });
}
