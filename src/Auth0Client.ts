import browser from "webextension-polyfill"

import {
  bufferToBase64UrlEncoded,
  createRandomString,
  createQueryParams,
  encode,
  sha256,
} from "./utils"

import { oauthToken } from "./api"

import { verifyIdToken } from "./jwt"

import {
  InMemoryCache,
  ICache,
  CacheKeyManifest,
  CacheManager,
  CacheKey,
} from "./cache"

import {
  DEFAULT_SCOPE,
  DEFAULT_NOW_PROVIDER,
  CACHE_LOCATION_MEMORY,
  CHILD_PORT_NAME,
  PARENT_PORT_NAME,
} from "./constants"

import {
  BaseLoginOptions,
  Auth0ClientOptions,
  CacheLocation,
  AuthorizeOptions,
  GetTokenSilentlyOptions,
  GetTokenSilentlyResult,
  AuthenticationResult,
  GetEntryFromCacheOptions,
  GetTokenSilentlyVerboseResult,
  User,
  GetUserOptions,
  IdToken,
  GetIdTokenClaimsOptions,
} from "./global"

/**
 * Auth0 SDK for Background Scripts in a Web Extension
 */
export default class Auth0Client {
  private cacheManager: CacheManager;
  private customOptions: BaseLoginOptions
  private domainUrl: string
  private tokenIssuer: string
  private defaultScope: string
  private scope: string | undefined
  private nowProvider: () => number | Promise<number>

  cacheLocation: CacheLocation | null

  constructor(private options: Auth0ClientOptions) {
    // TODO: validate crypto library
    // TODO: find a way to validate we are running in a background script

    if(options.cache && options.cacheLocation) {
      console.warn(
        "Both `cache` and `cacheLocation` options have been specified in the Auth0Client configuration; ignoring `cacheLocation` and using `cache`."
      );
    }

    let cache: ICache
    if(options.cache) {
      cache = options.cache;
      this.cacheLocation = null;
    } else {
      this.cacheLocation = options.cacheLocation || CACHE_LOCATION_MEMORY;

      const factory = cacheFactory(this.cacheLocation);

      if(!factory) {
        throw new Error(`Invalid cache location "${this.cacheLocation}"`);
      }

      cache = factory();
    }

    this.scope = this.options.scope;

    this.nowProvider = this.options.nowProvider || DEFAULT_NOW_PROVIDER;

    this.cacheManager = new CacheManager(
      cache,
      !cache.allKeys
        ? new CacheKeyManifest(cache, this.options.client_id)
        : null,
      this.nowProvider,
    )

    this.domainUrl = getDomain(this.options.domain);
    this.tokenIssuer = getTokenIssuer(this.options.issuer, this.domainUrl);

    this.defaultScope = getUniqueScopes(
      "openid",
      this.options?.advancedOptions?.defaultScope || DEFAULT_SCOPE,
    );

    if(this.options.useRefreshTokens) {
      // TODO: Add support for refresh tokens
    }

    this.customOptions = getCustomInitialOptions(options);
  }

  private _url(path: string) {
    // TODO: Not sure if we should include the auth0Client param or not?
    return `${this.domainUrl}${path}`
  }

  private _getParams(
    authorizeOptions: BaseLoginOptions,
    state: string,
    nonce: string,
    code_challenge: string,
    redirect_uri: string | undefined,
  ): AuthorizeOptions {
    // These options should be excluded from the authorize URL,
    // as they"re options for the client and not for the IdP.
    // ** IMPORTANT ** If adding a new client option, include it in this destructure list.
    const {
      useRefreshTokens,
      useCookiesForTransactions,
      useFormData,
      auth0Client,
      cacheLocation,
      advancedOptions,
      detailedResponse,
      nowProvider,
      authorizeTimeoutInSeconds,
      legacySameSiteCookie,
      sessionCheckExpiryDays,
      domain,
      leeway,
      ...loginOptions
    } = this.options;

    return {
      ...loginOptions,
      ...authorizeOptions,
      scope: getUniqueScopes(
        this.defaultScope,
        this.scope,
        authorizeOptions.scope
      ),
      response_type: "code",
      response_mode: "query",
      state,
      nonce,
      redirect_uri: redirect_uri || this.options.redirect_uri,
      code_challenge,
      code_challenge_method: "S256"
    };
  }

  private _authorizeUrl(authorizeOptions: AuthorizeOptions) {
    return this._url(`/authorize?${createQueryParams(authorizeOptions)}`);
  }

  /**
   * ```js
   * const user = await auth0.getUser();
   * ```
   *
   * Returns the user information if available (decoded from the `id_token`).
   *
   * If you provide an audience or scope, they should match an existing Access Token
   * (the SDK stores a corresponding ID Token with every Access Token, and uses the
   * scope and audience to look up the ID Token)
   *
   * @typeparam TUser The type to return, has to extend {@link User}.
   * @param options
   */
  public async getUser<TUser extends User>(
    options: GetUserOptions = {}
  ): Promise<TUser | undefined> {
    const audience = options.audience || this.options.audience || "default";
    const scope = getUniqueScopes(this.defaultScope, this.scope, options.scope);

    const cache = await this.cacheManager.get(
      new CacheKey({
        client_id: this.options.client_id,
        audience,
        scope,
      })
    );

    return cache?.decodedToken?.user as TUser | undefined;
  }

  /**
   * ```js
   * const claims = await auth0.getIdTokenClaims();
   * ```
   *
    Returns all claims from the id_token if available.
   *
   * If you provide an audience or scope, they should match an existin
   * (the SDK stores a corresponding ID Token with every Access Token,
   * scope and audience to look up the ID Token)
   *
   * @param options
   */
  public async getIdTokenClaims(
    options: GetIdTokenClaimsOptions = {}
  ): Promise<IdToken | undefined> {
    const audience = options.audience || this.options.audience || "default";
    const scope = getUniqueScopes(this.defaultScope, this.scope, options.scope);

    const cache = await this.cacheManager.get(
      new CacheKey({
        client_id: this.options.client_id,
        audience,
        scope,
      })
    );

    return cache?.decodedToken?.claims;
  }

  /**
   * ```js
   * const isAuthenticated = await auth0.isAuthenticated();
   * ```
   *
   * Returns `true` if there's valid information stored,
   * otherwise returns `false`.
   *
   */
  public async isAuthenticated() {
    const user = await this.getUser();
    return Boolean(user);
  }

  public async getTokenSilently(
    options: GetTokenSilentlyOptions & { detailedResponse: true }
  ): Promise<GetTokenSilentlyVerboseResult>

  public async getTokenSilently(
    options?: GetTokenSilentlyOptions,
  ): Promise<string>

  // TODO: Return verbose response if detailedResponse = true

  /**
   * Fetches a new access token
   *
   * ```js
   * const token = await auth0.getTokenSilently(options);
   * ```
   *
   * Refresh tokens are currently not supported
   */
  public async getTokenSilently(
    options: GetTokenSilentlyOptions = {},
  ): Promise<string | GetTokenSilentlyVerboseResult> {
    // FIXME: Should use keyed singlePromise like is auth0-spa-js
    return await this._getTokenSilently({
      audience: this.options.audience,
      ignoreCache: false,
      ...options,
      scope: getUniqueScopes(this.defaultScope, this.scope, options.scope),
    });
  }

  private async _getTokenSilently(
    options: GetTokenSilentlyOptions = {},
  ): Promise<string | GetTokenSilentlyVerboseResult> {
    const { ignoreCache, ...getTokenOptions } = options;

    if(!ignoreCache && getTokenOptions.scope) {
      const entry = await this._getEntryFromCache({
        scope: getTokenOptions.scope,
        audience: getTokenOptions.audience || "default",
        client_id: this.options.client_id,
        getDetailedEntry: options.detailedResponse,
      });

      if(entry) {
        return entry;
      }
    }

    // TODO: Acquire lock

    const authResult = this.options.useRefreshTokens
      ? await this._getTokenUsingRefreshToken(getTokenOptions)
      : await this._getTokenFromIfFrame(getTokenOptions);

    await this.cacheManager.set({
      client_id: this.options.client_id,
      ...authResult,
    })

    // TODO: Save to cookies

    if(options.detailedResponse) {
      const { id_token, access_token, oauthTokenScope, expires_in } = authResult;

      return {
        id_token,
        access_token,
        ...(oauthTokenScope ? { scope: oauthTokenScope } : null),
        expires_in,
      };
    }

    return authResult.access_token;
  }

  private async _getTokenUsingRefreshToken(
    options: GetTokenSilentlyOptions,
  ): Promise<GetTokenSilentlyResult> {
    throw "We currently don't support using refresh tokens, set useRefreshTokens to false";
  }

  private async _getTokenFromIfFrame(
    options: GetTokenSilentlyOptions,
  ): Promise<GetTokenSilentlyResult> {
    const stateIn = encode(createRandomString());
    const nonceIn = encode(createRandomString());
    const code_verifier = createRandomString();
    const code_challengeBuffer = await sha256(code_verifier);
    const code_challenge = bufferToBase64UrlEncoded(code_challengeBuffer);

    const params = this._getParams(
      options,
      stateIn,
      nonceIn,
      code_challenge,
      options.redirect_uri || this.options.redirect_uri,
    );

    // TODO: Add support for organizations

    const url = this._authorizeUrl({
      ...params,
      prompt: "none",
      response_mode: "web_message",
    });

    try {
      const codeResult = await this._performContentScriptHandshake(
        url,
        options.timeoutInSeconds || this.options.authorizeTimeoutInSeconds,
      );

      if(stateIn !== codeResult.state) {
        throw new Error("Invalid state");
      }

      const {
        scope,
        redirect_uri,
        audience,
        ignoreCache,
        timeoutInSeconds,
        detailedResponse,
        ...customOptions
      } = options;

      const tokenResult = await oauthToken({
        ...this.customOptions,
        ...customOptions,
        scope,
        audience,
        baseUrl: this.domainUrl,
        client_id: this.options.client_id,
        code_verifier,
        code: codeResult.code,
        grant_type: "authorization_code",
        redirect_uri: params.redirect_uri,
        useFormData: this.options.useFormData,
        auth0Client: {},
      });

      const decodedToken = await this._verifyIdToken(
        tokenResult.id_token,
        nonceIn,
      );

      return {
        ...tokenResult,
        decodedToken,
        scope: params.scope,
        oauthTokenScope: tokenResult.scope as string,
        audience: params.audience || "default",
      };
    } catch(e) {
      if((e as any).error === "login_required") {
        // TODO: Log user out
      }

      throw e;
    }
  }

  private async _performContentScriptHandshake(
    authorizeUrl: string,
    timeoutInSeconds?: number,
  ): Promise<AuthenticationResult> {

    const queryOptions = { currentWindow: true };
    let tabs = await browser.tabs.query(queryOptions);

    for(let tab of tabs) {
      if(tab.id) {
        const parentPort = browser.tabs.connect(tab.id, { name: PARENT_PORT_NAME });

        // Should be careful here that we don't accidentally connect to a different content script with an onConnect
        // handler. Maybe wait for a specific acknowledge message?
        if(browser.runtime.lastError) {
          continue;
        } else {
          return new Promise((resolve, reject) => {
            const handler = (childPort: browser.Runtime.Port) => {
              if(childPort.name === CHILD_PORT_NAME) {
                childPort.onMessage.addListener(message => {
                  resolve(message);

                  childPort.disconnect();
                  parentPort.disconnect();

                  browser.runtime.onConnect.removeListener(handler);
                });

                childPort.postMessage({
                  authorizeUrl,
                  domainUrl: this.domainUrl,
                });
              }
            }

            browser.runtime.onConnect.addListener(handler)
            parentPort.postMessage({});

            if(browser.runtime.lastError) {
              reject(browser.runtime.lastError);
            }
          });
        }
      }
    }

    throw "There are no tabs with content scripts running to connect to.";
  }

  private async _verifyIdToken(
    id_token: string,
    nonce?: string,
    organizationId?: string,
  ) {
    const now = await this.nowProvider();

    return verifyIdToken({
      iss: this.tokenIssuer,
      aud: this.options.client_id,
      id_token,
      nonce,
      organizationId,
      leeway: this.options.leeway,
      max_age: parseNumber(this.options.max_age),
      now,
    });
  }

  private async _getEntryFromCache({
    scope,
    audience,
    client_id,
    getDetailedEntry = false,
  }: GetEntryFromCacheOptions): Promise<string | GetTokenSilentlyVerboseResult | undefined> {
    const entry = await this.cacheManager.get(
      new CacheKey({
        scope,
        audience,
        client_id,
      }),
      60
    );

    if(entry && entry.access_token) {
      if(getDetailedEntry) {
        const { id_token, access_token, oauthTokenScope, expires_in } = entry;

        if(!id_token || !expires_in) {
          return undefined;
        }

        return {
          id_token,
          access_token,
          ...(oauthTokenScope ? { scope: oauthTokenScope } : null),
          expires_in,
        };
      } else {
        return entry.access_token;
      }
    }
  }
}

const parseNumber = (value: any): number | undefined => {
  if(typeof value !== "string") {
    return value;
  } else {
    return parseInt(value, 10) || undefined
  }
}

const getDomain = (domainUrl: string) => {
  if(!/^https?:\/\//.test(domainUrl)) {
    return `https://${domainUrl}`;
  } else {
    return domainUrl;
  }
}

const cacheLocationBuilders: Record<string, () => ICache> = {
  [CACHE_LOCATION_MEMORY]: () => new InMemoryCache().enclosedCache,
}

const cacheFactory = (location: string) => {
  return cacheLocationBuilders[location];
}

const getTokenIssuer = (issuer: string | undefined, domainUrl: string) => {
  if(issuer) {
    return issuer.startsWith("https://") ? issuer : `https://${issuer}/`;
  } else {
    return `${domainUrl}/`;
  }
}

const dedupe = (arr: string[]) => Array.from(new Set(arr));

const getUniqueScopes = (...scopes: (string | undefined)[]) => {
  return dedupe(scopes.filter(Boolean).join(" ").trim().split(/\s+/)).join(" ")
}

const getCustomInitialOptions = (
  options: Auth0ClientOptions
): BaseLoginOptions => {
  const {
    advancedOptions,
    audience,
    auth0Client,
    authorizeTimeoutInSeconds,
    cacheLocation,
    client_id,
    domain,
    issuer,
    leeway,
    max_age,
    redirect_uri,
    scope,
    useRefreshTokens,
    useCookiesForTransactions,
    useFormData,
    ...customParams
  } = options;
  return customParams;
}
