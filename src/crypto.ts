type TimingSafeSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView): boolean;
};

export function timingSafeEqual(left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView): boolean {
  return (crypto.subtle as TimingSafeSubtleCrypto).timingSafeEqual(left, right);
}

export function createDigestStream(algorithm: string): DigestStream {
  return new (crypto as Crypto & { DigestStream: typeof DigestStream }).DigestStream(algorithm);
}
