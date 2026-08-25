import { access } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeCredentials(value = {}) {
  return {
    email: clean(value.email),
    password: typeof value.password === "string" ? value.password : "",
    accessToken: clean(value.accessToken || value.access_token),
    refreshToken: clean(value.refreshToken || value.refresh_token),
    expiresAt: clean(value.expiresAt || value.expires_at) || null,
    cookie: clean(value.cookie),
    userAgent: clean(value.userAgent || value.user_agent),
  };
}

export function credentialsConfigured(credentials = {}) {
  const value = normalizeCredentials(credentials);
  return Boolean(value.accessToken || value.cookie || (value.email && value.password));
}

export function credentialsFromEnvironment(env = process.env) {
  return normalizeCredentials({
    email: env.AIHUB_EMAIL,
    password: env.AIHUB_PASSWORD,
    accessToken: env.AIHUB_ACCESS_TOKEN,
    refreshToken: env.AIHUB_REFRESH_TOKEN,
    expiresAt: env.AIHUB_ACCESS_TOKEN_EXPIRES_AT,
    cookie: env.AIHUB_COOKIE,
    userAgent: env.AIHUB_USER_AGENT,
  });
}

export function parseStoredCredential(value) {
  const text = String(value || "").trim();
  if (!text) return normalizeCredentials();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return normalizeCredentials(parsed);
  } catch {
    // Version 0.2 stored a single access token as the SecureString payload.
  }
  return normalizeCredentials({ accessToken: text });
}

function credentialSource(credentials, prefix) {
  if (credentials.email && credentials.password) return `${prefix}_login`;
  if (credentials.accessToken) return `${prefix}_token`;
  if (credentials.cookie) return `${prefix}_cookie`;
  return null;
}

export async function loadCredentials({ env = process.env, dataDir } = {}) {
  const environmentCredentials = credentialsFromEnvironment(env);
  if (credentialsConfigured(environmentCredentials)) {
    return {
      credentials: environmentCredentials,
      source: credentialSource(environmentCredentials, "environment"),
      error: null,
    };
  }
  if (process.platform !== "win32" || !dataDir) {
    return { credentials: normalizeCredentials(), source: null, error: null };
  }

  const credentialFile = path.join(dataDir, "credential.xml");
  try {
    await access(credentialFile);
  } catch (error) {
    if (error.code === "ENOENT") return { credentials: normalizeCredentials(), source: null, error: null };
    return { credentials: normalizeCredentials(), source: null, error: error.message };
  }

  const script = [
    `$secure = Import-Clixml -LiteralPath ${powershellLiteral(credentialFile)}`,
    "$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
    "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }",
    "finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }",
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const credentials = parseStoredCredential(stdout);
    return credentialsConfigured(credentials)
      ? { credentials, source: credentialSource(credentials, "windows_dpapi"), error: null }
      : { credentials, source: null, error: "Stored AIHub credential is empty" };
  } catch (error) {
    return {
      credentials: normalizeCredentials(),
      source: null,
      error: `Could not decrypt the stored AIHub credential: ${error.message}`,
    };
  }
}

// Kept for compatibility with older local integrations.
export async function loadAccessToken(options = {}) {
  const result = await loadCredentials(options);
  return {
    accessToken: result.credentials.accessToken,
    source: result.source,
    error: result.error,
  };
}
