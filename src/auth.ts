#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ 
    path: path.join(__dirname, '../.env'),
    quiet: true 
});

import { authorizeSpotify } from './utils.js';

console.log('Starting Spotify authentication flow...');
authorizeSpotify()
  .then(() => {
    console.log('Authentication completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Authentication failed:', error);
    process.exit(1);
  });
