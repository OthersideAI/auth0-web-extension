import { AuthenticationResult } from './global';
export declare const parseQueryResult: (queryString: string) => AuthenticationResult;
export declare const getCrypto: () => Crypto;
export declare const getCryptoSubtle: () => SubtleCrypto;
export declare const createRandomString: (length: number) => string;
export declare const createSecureRandomString: () => string;
export declare const encode: (value: string) => string;
export declare const decode: (value: string) => string;
export declare const createQueryParams: (params: any) => string;
export declare const sha256: (s: string) => Promise<any>;
export declare const urlDecodeB64: (input: string) => string;
export declare const bufferToBase64UrlEncoded: (input: number[] | Uint8Array) => string;
export declare const validateCrypto: () => void;
