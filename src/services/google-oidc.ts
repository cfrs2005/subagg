import * as oidc from 'openid-client';

const GOOGLE_ISSUER = new URL('https://accounts.google.com');

export interface VerifiedGoogleClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture: string | null;
}

export interface AuthorizationRequest {
  url: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export class GoogleOidcService {
  private configurationPromise: Promise<oidc.Configuration> | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly issuer = GOOGLE_ISSUER,
    private readonly allowInsecureForTests = false,
  ) {}

  private configuration(): Promise<oidc.Configuration> {
    if (!this.configurationPromise) {
      this.configurationPromise = oidc.discovery(
        this.issuer,
        this.clientId,
        this.clientSecret,
        undefined,
        {
          timeout: 10,
          ...(this.allowInsecureForTests ? { execute: [oidc.allowInsecureRequests] } : {}),
        },
      ).catch((error: unknown) => {
        this.configurationPromise = null;
        throw error;
      });
    }
    return this.configurationPromise;
  }

  async createAuthorizationRequest(callbackUri: string): Promise<AuthorizationRequest> {
    const configuration = await this.configuration();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const url = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: callbackUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return { url, state, nonce, codeVerifier };
  }

  async exchangeCallback(
    callbackUrl: URL,
    input: { callbackUri: string; state: string; nonce: string; codeVerifier: string },
  ): Promise<VerifiedGoogleClaims> {
    const configuration = await this.configuration();
    const tokens = await oidc.authorizationCodeGrant(
      configuration,
      callbackUrl,
      {
        expectedState: input.state,
        expectedNonce: input.nonce,
        pkceCodeVerifier: input.codeVerifier,
        idTokenExpected: true,
      },
      { redirect_uri: input.callbackUri },
    );
    const claims = tokens.claims();
    if (!claims) throw new Error('Google 未返回 ID Token claims');

    return {
      sub: typeof claims.sub === 'string' ? claims.sub : '',
      email: typeof claims.email === 'string' ? claims.email : '',
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === 'string' ? claims.name : '',
      picture: typeof claims.picture === 'string' ? claims.picture : null,
    };
  }
}
