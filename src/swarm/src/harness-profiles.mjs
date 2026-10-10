import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PI_VERSION = '1.1.0';
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
export const PI_INTEGRITY = 'sha512-SeEi/4hdcHNgA9UWlefZl7ZZpm3dzi2OoxNjDHsBJ9o298LNOtbL4DGKgitlEj6uCTccvtw6f2hlCkTPVJ2RXg==';
export const LOCAL_PI_DIRECTORY = fileURLToPath(new URL('../.swarm/tools/pi/', import.meta.url));
export const LOCAL_PI_BINARY = join(LOCAL_PI_DIRECTORY, 'node_modules', '.bin', process.platform === 'win32' ? 'pi.cmd' : 'pi');

/** Configure gateway routing without editing installed harness configuration. */
export async function prepareHarnessProfile({ harness, model, toolsEnabled, env, baseUrl }) {
  if (!env.LITELLM_API_KEY) throw new Error(`${harness} needs LITELLM_API_KEY for its isolated gateway profile.`);
  if (harness === 'opencode') {
    const config = {
      provider: { swarm: {
        npm: '@ai-sdk/openai', name: 'Swarm LiteLLM gateway',
        options: { baseURL: baseUrl, apiKey: '{env:LITELLM_API_KEY}' },
        models: { [model]: { name: model, limit: { context: 128000, output: 16384 } } },
      } },
      // A headless 'ask' rejects the whole turn; deny returns a recoverable tool error.
      permission: toolsEnabled ? {external_directory: 'deny'} : {'*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow'},
    };
    if (toolsEnabled) return {cleanup: async () => {}, environment: {OPENCODE_CONFIG_CONTENT: JSON.stringify(config)}};
    // Elections/inspection must not load project permission overrides or hooks.
    const directory = await mkdtemp(join(tmpdir(), 'swarm-opencode-inspect-'));
    return {cleanup: () => rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 150}), environment: {
      XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, XDG_STATE_HOME: directory, XDG_CACHE_HOME: directory,
      OPENCODE_TEST_HOME: directory, OPENCODE_CONFIG_DIR: directory,
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    }};
  }
  const directory = await mkdtemp(join(tmpdir(), `swarm-${harness}-`));
  const cleanup = () => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  try {
    if (harness === 'codex') return { cleanup, environment: { CODEX_HOME: directory } };
    if (harness === 'pi') {
      await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: { swarm: {
        baseUrl, api: 'openai-responses', apiKey: '${LITELLM_API_KEY}',
        models: [{ id: model, name: model, reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 16384 }],
      } } }), { mode: 0o600 });
      return { cleanup, environment: {
        PI_CODING_AGENT_DIR: directory,
      } };
    }
    throw new Error(`Unsupported gateway profile: ${harness}`);
  } catch (error) { await cleanup(); throw error; }
}
