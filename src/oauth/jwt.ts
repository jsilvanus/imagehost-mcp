import { SignJWT, jwtVerify, type JWTVerifyResult } from 'jose';

export async function issueAccessToken(
  secret: Uint8Array,
  issuer: string,
  resource: string,
  subject: string,
  clientId: string,
  scope: string,
): Promise<string> {
  return new SignJWT({ client_id: clientId, scope })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setIssuer(issuer)
    .setAudience(resource)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);
}

export async function verifyAccessToken(
  secret: Uint8Array,
  issuer: string,
  resource: string,
  token: string,
): Promise<JWTVerifyResult> {
  return jwtVerify(token, secret, { algorithms: ['HS256'], issuer, audience: resource });
}
