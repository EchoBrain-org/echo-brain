// Also sent verbatim to the accepted image's Node runtime. Only ciphertext
// leaves that process; the AES key is wrapped for the requesting Mac.
import { constants, createCipheriv, publicEncrypt, randomBytes } from 'node:crypto';

export function sealInvitationPayload(payload, recipient, aad) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'hex'));
  const data = Buffer.concat([cipher.update(payload), cipher.final()]);
  return {
    version: 1,
    key: publicEncrypt({ key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}
