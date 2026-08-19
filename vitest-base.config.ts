import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        // jsdom only exposes localStorage/sessionStorage for a non-opaque origin. Without an
        // explicit URL the document lands on an opaque one and both are left undefined, which
        // the app hits on startup through PostsService.
        url: 'http://localhost'
      }
    }
  }
});
