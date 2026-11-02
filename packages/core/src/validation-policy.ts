import { z } from 'zod';

// Shared chunks and dedicated workers can initialize schemas before main.tsx.
// This dependency must run before any schema is created, without JS eval.
z.config({ jitless: true });
