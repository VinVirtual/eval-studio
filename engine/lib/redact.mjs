// Keeps secrets out of run files and reports. Two layers: the literal values of secret-looking
// environment variables, and patterns for common key formats. It catches obvious secrets only.
import { isObj } from './util.mjs'

export const MASK = '[redacted]'

const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JSON web token
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
]
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g
// "api_key=...", "password": "...". The value must look like a credential (no spaces, at least 8
// characters with a digit, or 20 or more characters), so prose such as "Password: required" is kept.
const ASSIGNMENT = /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|secret|password|passwd|token)["']?[ \t]*[:=][ \t]*["']?)([A-Za-z0-9._~+/=!@#$%^*-]{8,})/gi
const LOOKS_LIKE_CREDENTIAL = /^(?=.*\d)[^\s]{8,}$|^[^\s]{20,}$/
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i
const MIN_SECRET_LENGTH = 8

/** Values worth masking: variables named like secrets, plus any the config refers to by name. */
export function secretValues(env = process.env, names = []) {
  const wanted = new Set(names)
  const values = Object.entries(env)
    .filter(([name, value]) => typeof value === 'string' && value.length >= MIN_SECRET_LENGTH && (wanted.has(name) || SECRET_NAME.test(name)))
    .map(([, value]) => value)
  return [...new Set(values)].sort((a, b) => b.length - a.length)
}

export function redactText(text, secrets = []) {
  let out = String(text)
  for (const secret of secrets) if (secret) out = out.split(secret).join(MASK)
  for (const pattern of PATTERNS) out = out.replace(pattern, MASK)
  return out
    .replace(BEARER, `$1 ${MASK}`)
    .replace(ASSIGNMENT, (whole, name, value) => (LOOKS_LIKE_CREDENTIAL.test(value) ? `${name}${MASK}` : whole))
    .replace(URL_CREDENTIALS, `$1${MASK}$3`)
}

/** A redacted copy of any JSON-like value. Keys are kept; every string value is cleaned. */
export function redactDeep(value, secrets = []) {
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets))
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)]))
  return value
}
