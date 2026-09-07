declare module 'simple-oauth2' {
  export interface OAuthToken {
    access_token: string;
    token_type?: string;
    refresh_token?: string;
    expires_in?: number;
    [key: string]: unknown;
  }

  export class AuthorizationCode {
    constructor(options: {
      client: { id: string; secret: string };
      auth: {
        tokenHost: string;
        tokenPath?: string;
        authorizePath?: string;
        [key: string]: string | undefined;
      };
      options?: Record<string, unknown>;
    });
    authorizeURL(params: {
      redirect_uri?: string;
      scope?: string;
      state?: string;
      [key: string]: unknown;
    }): string;
    getToken(params: {
      code: string;
      redirect_uri?: string;
      [key: string]: unknown;
    }): Promise<{ token: OAuthToken }>;
  }
}
