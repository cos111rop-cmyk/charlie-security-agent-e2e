import { defineConfig, type Project } from '@playwright/test';

type AgentMode = 'mock' | 'live' | 'live-mutating';
const MODES: AgentMode[] = ['mock', 'live', 'live-mutating'];

/**
 * One project per mode. Each run targets exactly one mode:
 *   --project=mock            every test, against the built-in mock agent (default)
 *   --project=live            @live tests only: read-only, safe on any agent
 *   --project=live-mutating   @live and @live-mutating tests: disposable terminals only
 * Aliases kept for older scripts: USE_MOCK_AGENT=false selects "live", and adding
 * ALLOW_LIVE_MUTATIONS=true selects "live-mutating".
 */
const projectsByMode: Record<AgentMode, Project> = {
  mock: { name: 'mock' },
  live: { name: 'live', grep: /@live(?![-\w])/ },
  'live-mutating': { name: 'live-mutating', grep: /@live(?:-mutating)?(?![-\w])/ },
};

function projectsFromArgv(): string[] {
  const names: string[] = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--project=')) names.push(argv[i].slice('--project='.length));
    else if (argv[i] === '--project' && argv[i + 1]) names.push(argv[++i]);
  }
  return [...new Set(names)];
}

function modeFromAliases(): AgentMode | undefined {
  if (process.env.USE_MOCK_AGENT !== 'false') return undefined;
  return process.env.ALLOW_LIVE_MUTATIONS === 'true' ? 'live-mutating' : 'live';
}

function resolveMode(): AgentMode {
  const fromArgv = projectsFromArgv();
  if (fromArgv.length > 1) {
    throw new Error(`Run one mode at a time; got --project ${fromArgv.join(', ')}.`);
  }
  if (fromArgv[0] && !MODES.includes(fromArgv[0] as AgentMode)) {
    throw new Error(`Unknown project "${fromArgv[0]}". Use one of: ${MODES.join(', ')}.`);
  }
  // Test workers re-load this file without the CLI arguments; they inherit AGENT_MODE.
  const fromEnv = (process.env.AGENT_MODE as AgentMode | undefined) || modeFromAliases();
  const fromCli = fromArgv[0] as AgentMode | undefined;
  if (fromCli && fromEnv && fromCli !== fromEnv) {
    throw new Error(
      `--project=${fromCli} conflicts with the environment, which selects "${fromEnv}" ` +
        `(AGENT_MODE / USE_MOCK_AGENT / ALLOW_LIVE_MUTATIONS). Unset those or make them agree.`
    );
  }
  return fromCli || fromEnv || 'mock';
}

const mode = resolveMode();
process.env.AGENT_MODE = mode;

if (mode !== 'mock' && !process.env.AGENT_WS_URL) {
  throw new Error(
    `The "${mode}" project needs the agent's address, e.g. AGENT_WS_URL=ws://<terminal-ip>:8080.`
  );
}

export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  // No retries: a retry would hide order-dependent or flaky tests.
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.AGENT_WS_URL || 'ws://127.0.0.1:8080',
  },
  // Only the selected mode's project exists, so a plain `playwright test` never runs a test twice.
  projects: [projectsByMode[mode]],
  webServer:
    mode === 'mock'
      ? {
          command: 'npx tsx mock-server/server.ts',
          env: { HEARTBEAT_MS: '400' },
          port: 8080,
          reuseExistingServer: !process.env.CI,
          timeout: 15_000,
        }
      : undefined,
});
