// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // The public address of the blog once it is deployed. The RSS feed needs it.
  site: 'https://elmehdimotaqi.com',
  markdown: {
    shikiConfig: {
      // A light, low-contrast theme so code reads like the rest of the page.
      theme: 'github-light',
    },
  },
});
