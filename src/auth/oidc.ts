import * as client from 'openid-client';
import type { Config } from '../config.js';

export interface OidcAuthStart {
  url: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export class OidcClientService {
  private configPromise: Promise<client.Configuration> | null = null;

  constructor(
    private readonly config: Config,
    private readonly redirectUri: string,
  ) {}

  private async getConfiguration(): Promise<client.Configuration> {
    if (!this.configPromise) {
      const issuerUrl = new URL(this.config.oidcIssuerUrl);
      const allowHttp = issuerUrl.protocol === 'http:';
      this.configPromise = client
        .discovery(
          issuerUrl,
          this.config.oidcClientId,
          undefined,
          this.config.oidcClientSecret
            ? client.ClientSecretPost(this.config.oidcClientSecret)
            : client.None(),
          allowHttp ? { execute: [client.allowInsecureRequests] } : undefined,
        )
        .catch((err) => {
          this.configPromise = null;
          throw err;
        });
    }
    return this.configPromise;
  }

  async startLogin(): Promise<OidcAuthStart> {
    const configuration = await this.getConfiguration();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri,
      scope: 'openid profile email',
      response_type: 'code',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return { url, state, nonce, codeVerifier };
  }

  async handleCallback(
    currentUrl: URL,
    expectedState: string,
    expectedNonce: string,
    codeVerifier: string,
  ): Promise<{
    issuer: string;
    sub: string;
    email?: string;
    name?: string;
  }> {
    const configuration = await this.getConfiguration();
    const tokenSet = await client.authorizationCodeGrant(configuration, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState,
      expectedNonce,
    });

    const claims = tokenSet.claims();
    if (!claims || !claims.sub) {
      throw new Error('Missing sub claim in ID token');
    }

    return {
      issuer: claims.iss,
      sub: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      name: typeof claims.name === 'string' ? claims.name : undefined,
    };
  }
}
