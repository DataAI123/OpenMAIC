import { EncryptJWT, jwtDecrypt } from 'jose';

import type { OidcAuthConfig } from './config';

const FLOW_ISSUER = 'openmaic';
const FLOW_AUDIENCE = 'openmaic:oidc-flow';
const FLOW_TYPE = 'openmaic-oidc-flow+jwe';
const FLOW_TTL_SECONDS = 10 * 60;
const FLOW_COOKIE_PREFIX = 'openmaic_oidc_flow_';
const MAX_PARALLEL_FLOWS = 3;
const MAX_RETURN_TO_LENGTH = 2048;

export interface OidcFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  issuedAt: number;
}

function parseCookieHeader(cookieHeader: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader || cookieHeader.length > 16_384) return cookies;
  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (cookies.has(name)) {
      cookies.set(name, '');
      continue;
    }
    cookies.set(name, value);
  }
  return cookies;
}

function isValidState(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

export function flowCookieName(state: string): string {
  if (!isValidState(state)) throw new Error('Invalid OIDC state');
  const prefix =
    process.env.NODE_ENV === 'production' ? `__Host-${FLOW_COOKIE_PREFIX}` : FLOW_COOKIE_PREFIX;
  return `${prefix}${state}`;
}

export function readFlowCookie(headers: Headers, state: string): string | null {
  const value = parseCookieHeader(headers.get('cookie')).get(flowCookieName(state));
  return value || null;
}

export function countFlowCookies(headers: Headers): number {
  return [...parseCookieHeader(headers.get('cookie')).keys()].filter(
    (name) =>
      name.startsWith(FLOW_COOKIE_PREFIX) || name.startsWith(`__Host-${FLOW_COOKIE_PREFIX}`),
  ).length;
}

function buildFlowCookieHeader(state: string, value: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return (
    `${flowCookieName(state)}=${value}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${FLOW_TTL_SECONDS}${secure}`
  );
}

export function clearFlowCookieHeader(state: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${flowCookieName(state)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export async function sealOidcFlowState(
  state: OidcFlowState,
  config: OidcAuthConfig,
): Promise<string> {
  if (!isValidState(state.state) || state.returnTo.length > MAX_RETURN_TO_LENGTH) {
    throw new Error('Invalid OIDC flow state');
  }
  return new EncryptJWT({ ...state })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: FLOW_TYPE })
    .setIssuer(FLOW_ISSUER)
    .setAudience(FLOW_AUDIENCE)
    .setIssuedAt(state.issuedAt)
    .setExpirationTime(state.issuedAt + FLOW_TTL_SECONDS)
    .encrypt(config.flowEncryptionKey);
}

export async function openOidcFlowState(
  value: string,
  config: OidcAuthConfig,
  expectedState: string,
): Promise<OidcFlowState> {
  const { payload, protectedHeader } = await jwtDecrypt(value, config.flowEncryptionKey, {
    keyManagementAlgorithms: ['dir'],
    contentEncryptionAlgorithms: ['A256GCM'],
    issuer: FLOW_ISSUER,
    audience: FLOW_AUDIENCE,
    maxTokenAge: FLOW_TTL_SECONDS,
    clockTolerance: 5,
  });
  if (protectedHeader.typ !== FLOW_TYPE) throw new Error('Invalid OIDC flow token type');
  const flow = payload as Partial<OidcFlowState>;
  if (
    flow.state !== expectedState ||
    !isValidState(flow.state) ||
    typeof flow.nonce !== 'string' ||
    typeof flow.codeVerifier !== 'string' ||
    typeof flow.returnTo !== 'string' ||
    typeof flow.issuedAt !== 'number' ||
    flow.returnTo.length > MAX_RETURN_TO_LENGTH
  ) {
    throw new Error('Invalid OIDC flow state');
  }
  return flow as OidcFlowState;
}

export function serializeFlowCookie(state: string, value: string): string {
  return buildFlowCookieHeader(state, value);
}

export const oidcFlowLimits = {
  maxParallelFlows: MAX_PARALLEL_FLOWS,
  ttlSeconds: FLOW_TTL_SECONDS,
};
