import crypto from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';
import { SpotifyApi } from '@spotify/web-api-ts-sdk';

// Rimosse le librerie 'fs', 'path' e 'open' incompatibili con Cloud Run

// Variabile in RAM per mantenere i token vivi finché il container è acceso
let memoryStore: Partial<SpotifyConfig> = {
  accessToken: undefined,
  refreshToken: process.env.SPOTIFY_REFRESH_TOKEN || undefined, // Il vero trucco
  expiresAt: undefined
};

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; 
}

export function loadSpotifyConfig(): SpotifyConfig {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = process.env.REDIRECT_URI || "http://localhost:8080/callback";

  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET environment variables.',
    );
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
    accessToken: memoryStore.accessToken,
    refreshToken: memoryStore.refreshToken,
    expiresAt: memoryStore.expiresAt,
  };
}

export function saveSpotifyConfig(config: SpotifyConfig): void {
  // Salviamo in memoria RAM invece che sul disco
  memoryStore.accessToken = config.accessToken;
  memoryStore.refreshToken = config.refreshToken;
  memoryStore.expiresAt = config.expiresAt;
  console.log('Tokens salvati in memoria con successo.');
}

let cachedSpotifyApi: SpotifyApi | null = null;

export async function createSpotifyApi(): Promise<SpotifyApi> {
  const config = loadSpotifyConfig();

  // Se abbiamo un refresh token (passato da Cloud Run via ENV), lo usiamo
  if (config.refreshToken) {
    const now = Date.now();
    const shouldRefresh = !config.expiresAt || config.expiresAt <= now;

    if (shouldRefresh) {
      console.log('Token scaduto o mancante, tento il refresh...');
      try {
        const tokens = await refreshAccessToken(config);
        config.accessToken = tokens.access_token;
        config.expiresAt = now + tokens.expires_in * 1000;
        saveSpotifyConfig(config);
        cachedSpotifyApi = null;
      } catch (error) {
        console.error('Refresh token fallito:', error);
      }
    }

    if (cachedSpotifyApi) return cachedSpotifyApi;

    if (config.accessToken) {
        const accessToken = {
        access_token: config.accessToken,
        token_type: 'Bearer',
        expires_in: Math.floor(((config.expiresAt ?? now + 3600000) - now) / 1000),
        refresh_token: config.refreshToken,
        };
        cachedSpotifyApi = SpotifyApi.withAccessToken(config.clientId, accessToken);
        return cachedSpotifyApi;
    }
  }

  // Fallback se non c'è token utente
  console.log("Nessun Refresh Token trovato. Uso le Client Credentials (solo ricerca, no controllo playback).");
  cachedSpotifyApi = SpotifyApi.withClientCredentials(config.clientId, config.clientSecret);
  return cachedSpotifyApi;
}

function base64Encode(str: string): string {
  return Buffer.from(str).toString('base64');
}

async function refreshAccessToken(config: SpotifyConfig): Promise<{ access_token: string; expires_in: number }> {
  if (!config.refreshToken) throw new Error('No refresh token available');

  const tokenUrl = 'https://accounts.spotify.com/api/token';
  const authHeader = `Basic ${base64Encode(`${config.clientId}:${config.clientSecret}`)}`;
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', config.refreshToken);

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!response.ok) throw new Error(`Refresh fallito: ${await response.text()}`);
  const data = await response.json();
  return { access_token: data.access_token, expires_in: data.expires_in || 3600 };
}

// Manteniamo le funzioni ausiliarie invariate
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}:${seconds.padStart(2, '0')}`;
}

export async function handleSpotifyRequest<T>(action: (spotifyApi: SpotifyApi) => Promise<T>): Promise<T> {
  try {
    const spotifyApi = await createSpotifyApi();
    return await action(spotifyApi);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('Unexpected token') || errorMessage.includes('JSON')) {
      return undefined as T;
    }
    throw error;
  }
}

// Disabilitiamo il flusso di auth locale che fa crashare il cloud
export async function authorizeSpotify(): Promise<void> {
    console.error("ATTENZIONE: autorizzazione tramite web server locale disabilitata per compatibilità Cloud Run.");
    console.error("Per usare il controllo playback: autenticati in locale sul tuo PC, copia il 'refreshToken' dal file json e inseriscilo in Cloud Run come variabile SPOTIFY_REFRESH_TOKEN.");
}
