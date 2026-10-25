import { z } from 'zod';

// Run before any app schemas are constructed. Avoid even caught eval probes under strict CSP.
z.config({ jitless: true });
