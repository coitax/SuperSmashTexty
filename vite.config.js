import { defineConfig, loadEnv } from 'vite';
import { execSync } from 'child_process';

// ============================================================================
// AUTOMATIC VERSION SYSTEM - DO NOT REMOVE OR MODIFY
// ============================================================================
// This generates the game version displayed in the menu (e.g., v0.1.151)
// Version = v0.1.<git_commit_count>
// Used by: src/scenes/menu.js via __APP_VERSION__ global
// Docs: See GIT_WORKFLOW.md "Automatic Version Numbering" section
// ============================================================================
function getGitCommitCount() {
  try {
    return execSync('git rev-list --count HEAD').toString().trim();
  } catch {
    return '0';
  }
}

// VITE_TURN_CREDENTIALS_URL is compiled into the client, so it must point at a
// backend that issues short-lived TURN credentials, never carry a secret itself.
function assertNoSecretInTurnUrl(value) {
  if (!value) return;
  let url;
  try {
    url = new URL(value, 'http://relative.invalid');
  } catch {
    throw new Error('VITE_TURN_CREDENTIALS_URL is not a valid URL');
  }
  const secretParam = [...url.searchParams.keys()]
    .find((name) => /key|secret|token|pass|cred|auth|sig/i.test(name));
  if (url.username || url.password || secretParam) {
    throw new Error('VITE_TURN_CREDENTIALS_URL must not embed credentials; issue short-lived TURN credentials from a backend instead');
  }
}

export default defineConfig(({ command, mode }) => {
  assertNoSecretInTurnUrl(loadEnv(mode, process.cwd(), 'VITE_').VITE_TURN_CREDENTIALS_URL);
  const commitCount = getGitCommitCount();
  // Use '/SuperSmashTexty/' base path for production builds (GitHub Pages)
  // Use '/' for local development
  const base = command === 'build' ? '/SuperSmashTexty/' : '/';
  
  return {
    base,
    // DO NOT REMOVE: Auto-version system (see comment at top of file)
    define: {
      __APP_VERSION__: JSON.stringify(`v0.1.${commitCount}`)
    },
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      sourcemap: true,
      rollupOptions: {
        input: {
          main: './index.html'
        }
      }
    },
    server: {
      port: 3010, // Match package.json dev script
      open: true
    }
  };
});






