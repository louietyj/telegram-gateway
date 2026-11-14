/** Constant-time string comparison (hashing first makes lengths equal). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/** The client token from `Authorization: Bearer` or `x-api-key`. Never the URL: URLs get logged. */
export function presentedToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return request.headers.get("x-api-key");
}

export async function hasToken(request: Request, expected: string): Promise<boolean> {
  const token = presentedToken(request);
  return token !== null && (await safeEqual(token, expected));
}
