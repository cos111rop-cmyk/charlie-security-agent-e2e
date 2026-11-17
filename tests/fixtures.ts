import { test as base, expect } from '@playwright/test';
import { AGENT_MODE } from './ws-client';

/** Every test carries exactly one of these tags; the Playwright projects select on them. */
export const MODE_TAGS = ['@live', '@live-mutating', '@mock-only'] as const;

/**
 * Use this `test` instead of the one from @playwright/test. Its automatic fixture runs before
 * every test (and before beforeEach) and fails loudly, instead of skipping, when a test is
 * untagged or runs in a mode it cannot prove anything in.
 */
export const test = base.extend<{ modeGuard: void }>({
  modeGuard: [
    async ({}, use, testInfo) => {
      const tags = testInfo.tags.filter((t) => (MODE_TAGS as readonly string[]).includes(t));
      if (tags.length !== 1) {
        throw new Error(
          `"${testInfo.title}" must carry exactly one of ${MODE_TAGS.join(', ')} (found: ${tags.join(', ') || 'none'}).`
        );
      }
      if (tags[0] === '@mock-only' && AGENT_MODE !== 'mock') {
        throw new Error(
          `@mock-only test ran in "${AGENT_MODE}" mode. It needs the mock agent's control plane ` +
            `(fault injection or state inspection) and proves nothing against a real agent.`
        );
      }
      if (tags[0] === '@live-mutating' && AGENT_MODE === 'live') {
        throw new Error(
          `@live-mutating test ran in read-only "live" mode. It changes agent data; run it with ` +
            `--project=live-mutating on a disposable terminal only.`
        );
      }
      await use();
    },
    { auto: true },
  ],
});

export { expect };
