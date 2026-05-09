import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { SpotifyApi } from '@spotify/web-api-ts-sdk';
import open from 'open';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '../.env');
const CONFIG_FILE = path.join(__dirname, '../spotify-config.json');

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // Unix timestamp in milliseconds
}

export function loadSpotifyConfig(): SpotifyConfig {
  const config: SpotifyConfig = {
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
    redirectUri: process.env.SPOTIFY_REDIRECT_URI || '',
    accessToken: process.env.SPOTIFY_ACCESS_TOKEN,
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
    expiresAt: process.env.SPOTIFY_EXPIRES_AT ? Number.parseInt(process.env.SPOTIFY_EXPIRES_AT) : undefined,
  };

  // Fallback to JSON if env vars are missing (backward compatibility during transition)
  if (!config.clientId && fs.existsSync(CONFIG_FILE)) {
    try {
      const jsonConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      config.clientId = jsonConfig.clientId || config.clientId;
      config.clientSecret = jsonConfig.clientSecret || config.clientSecret;
      config.redirectUri = jsonConfig.redirectUri || config.redirectUri;
      config.accessToken = jsonConfig.accessToken || config.accessToken;
      config.refreshToken = jsonConfig.refreshToken || config.refreshToken;
      config.expiresAt = jsonConfig.expiresAt || config.expiresAt;
    } catch (error) {
      console.warn('Failed to parse legacy spotify-config.json:', error);
    }
  }

  if (!(config.clientId && config.clientSecret && config.redirectUri)) {
    throw new Error(
      'Spotify configuration must include SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REDIRECT_URI in environment variables or .env file.',
    );
  }

  return config;
}

export function saveSpotifyConfig(config: SpotifyConfig): void {
  // Update process.env for current session
  process.env.SPOTIFY_ACCESS_TOKEN = config.accessToken;
  process.env.SPOTIFY_REFRESH_TOKEN = config.refreshToken;
  process.env.SPOTIFY_EXPIRES_AT = config.expiresAt?.toString();

  // Try to update .env file for persistence (local development)
  try {
    let envContent = '';
    if (fs.existsSync(ENV_FILE)) {
      envContent = fs.readFileSync(ENV_FILE, 'utf8');
    }

    const updates = {
      SPOTIFY_CLIENT_ID: config.clientId,
      SPOTIFY_CLIENT_SECRET: config.clientSecret,
      SPOTIFY_REDIRECT_URI: config.redirectUri,
      SPOTIFY_ACCESS_TOKEN: config.accessToken || '',
      SPOTIFY_REFRESH_TOKEN: config.refreshToken || '',
      SPOTIFY_EXPIRES_AT: config.expiresAt?.toString() || '',
    };

    let newContent = envContent;
    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(newContent)) {
        newContent = newContent.replace(regex, `${key}=${value}`);
      } else {
        newContent += `\n${key}=${value}`;
      }
    }

    fs.writeFileSync(ENV_FILE, newContent.trim() + '\n', 'utf8');
  } catch (error) {
    console.warn('Could not save to .env file (this is expected in some cloud environments):', error);
  }
}

let cachedSpotifyApi: SpotifyApi | null = null;

export async function createSpotifyApi(): Promise<SpotifyApi> {
  const config = loadSpotifyConfig();

  if (config.accessToken && config.refreshToken) {
    const now = Date.now();
    const shouldRefresh = !config.expiresAt || config.expiresAt <= now;

    if (shouldRefresh) {
      console.log(
        'Access token expired or missing expiration time, refreshing...',
      );
      try {
        const tokens = await refreshAccessToken(config);
        config.accessToken = tokens.access_token;
        config.expiresAt = now + tokens.expires_in * 1000; // Convert seconds to milliseconds
        saveSpotifyConfig(config);
        console.log('Access token refreshed successfully');

        // Clear cached API instance to force recreation with new token
        cachedSpotifyApi = null;
      } catch (error) {
        console.error('Failed to refresh token:', error);
        throw new Error(
          'Failed to refresh access token. Please run "npm run auth" to re-authenticate.',
        );
      }
    }

    if (cachedSpotifyApi) {
      return cachedSpotifyApi;
    }

    const accessToken = {
      access_token: config.accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(
        ((config.expiresAt ?? now + 3600000) - now) / 1000,
      ),
      refresh_token: config.refreshToken,
    };

    cachedSpotifyApi = SpotifyApi.withAccessToken(config.clientId, accessToken);
    return cachedSpotifyApi;
  }

  // Fallback to client credentials if no user tokens available
  cachedSpotifyApi = SpotifyApi.withClientCredentials(
    config.clientId,
    config.clientSecret,
  );

  return cachedSpotifyApi;
}

function generateRandomString(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
        b % 62,
      ),
    )
    .join('');
}

function base64Encode(str: string): string {
  return Buffer.from(str).toString('base64');
}

async function exchangeCodeForToken(
  code: string,
  config: SpotifyConfig,
): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const tokenUrl = 'https://accounts.spotify.com/api/token';
  const authHeader = `Basic ${base64Encode(`${config.clientId}:${config.clientSecret}`)}`;

  const params = new URLSearchParams();
  params.append('grant_type', 'authorization_code');
  params.append('code', code);
  params.append('redirect_uri', config.redirectUri);

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Failed to exchange code for token: ${errorData}`);
  }

  const data = await response.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in || 3600,
  };
}

async function refreshAccessToken(
  config: SpotifyConfig,
): Promise<{ access_token: string; expires_in: number }> {
  if (!config.refreshToken) {
    throw new Error('No refresh token available');
  }

  const tokenUrl = 'https://accounts.spotify.com/api/token';
  const authHeader = `Basic ${base64Encode(`${config.clientId}:${config.clientSecret}`)}`;

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', config.refreshToken);

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Failed to refresh access token: ${errorData}`);
  }

  const data = await response.json();
  return {
    access_token: data.access_token,
    expires_in: data.expires_in || 3600,
  };
}

export async function authorizeSpotify(): Promise<void> {
  const config = loadSpotifyConfig();

  const redirectUri = new URL(config.redirectUri);
  if (
    redirectUri.hostname !== 'localhost' &&
    redirectUri.hostname !== '127.0.0.1'
  ) {
    console.error(
      'Error: Redirect URI must use localhost for automatic token exchange',
    );
    console.error(
      'Please update your .env file with a localhost redirect URI',
    );
    console.error('Example: http://127.0.0.1:8888/callback');
    process.exit(1);
  }

  const port = redirectUri.port || '80';
  const callbackPath = redirectUri.pathname || '/callback';

  const state = generateRandomString(16);

  const scopes = [
    'user-read-private',
    'user-read-email',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'playlist-read-private',
    'playlist-modify-private',
    'playlist-modify-public',
    'user-library-read',
    'user-library-modify',
    'user-read-recently-played',
    'user-modify-playback-state',
    'user-read-playback-state',
    'user-read-currently-playing',
  ];

  const authParams = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    scope: scopes.join(' '),
    state: state,
    show_dialog: 'true',
  });

  const authorizationUrl = `https://accounts.spotify.com/authorize?${authParams.toString()}`;

  const authPromise = new Promise<void>((resolve, reject) => {
    // Create HTTP server to handle the callback
    const server = http.createServer(async (req, res) => {
      if (!req.url) {
        return res.end('No URL provided');
      }

      const reqUrl = new URL(req.url, `http://localhost:${port}`);

      if (reqUrl.pathname === callbackPath) {
        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');
        const error = reqUrl.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html' });

        if (error) {
          console.error(`Authorization error: ${error}`);
          res.end(
            '<html><body><h1>Authentication Failed</h1><p>Please close this window and try again.</p></body></html>',
          );
          server.close();
          reject(new Error(`Authorization failed: ${error}`));
          return;
        }

        if (returnedState !== state) {
          console.error('State mismatch error');
          res.end(
            '<html><body><h1>Authentication Failed</h1><p>State verification failed. Please close this window and try again.</p></body></html>',
          );
          server.close();
          reject(new Error('State mismatch'));
          return;
        }

        if (!code) {
          console.error('No authorization code received');
          res.end(
            '<html><body><h1>Authentication Failed</h1><p>No authorization code received. Please close this window and try again.</p></body></html>',
          );
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        try {
          const tokens = await exchangeCodeForToken(code, config);

          config.accessToken = tokens.access_token;
          config.refreshToken = tokens.refresh_token;
          config.expiresAt = Date.now() + tokens.expires_in * 1000; // Convert seconds to milliseconds
          saveSpotifyConfig(config);

          res.end(
            '<html><body><h1>Authentication Successful!</h1><p>You can now close this window and return to the application.</p></body></html>',
          );
          console.log(
            'Authentication successful! Access token has been saved.',
          );

          server.close();
          resolve();
        } catch (error) {
          console.error('Token exchange error:', error);
          res.end(
            '<html><body><h1>Authentication Failed</h1><p>Failed to exchange authorization code for tokens. Please close this window and try again.</p></body></html>',
          );
          server.close();
          reject(error);
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(Number.parseInt(port), '127.0.0.1', () => {
      console.log(
        `Listening for Spotify authentication callback on port ${port}`,
      );
      console.log('Opening browser for authorization...');

      open(authorizationUrl).catch((_error: Error) => {
        console.log(
          'Failed to open browser automatically. Please visit this URL to authorize:',
        );
        console.log(authorizationUrl);
      });
    });

    server.on('error', (error) => {
      console.error(`Server error: ${error.message}`);
      reject(error);
    });
  });

  await authPromise;
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}:${seconds.padStart(2, '0')}`;
}

export async function handleSpotifyRequest<T>(
  action: (spotifyApi: SpotifyApi) => Promise<T>,
): Promise<T> {
  try {
    const spotifyApi = await createSpotifyApi();
    return await action(spotifyApi);
  } catch (error) {
    // Skip JSON parsing errors as these are actually successful operations
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.includes('Unexpected token') ||
      errorMessage.includes('Unexpected non-whitespace character') ||
      errorMessage.includes('Exponent part is missing a number in JSON')
    ) {
      return undefined as T;
    }
    // Rethrow other errors
    throw error;
  }
}
