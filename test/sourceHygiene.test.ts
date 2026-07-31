import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * One assertion about the shape of the tree rather than about its behaviour.
 *
 * A NUL byte in a `.ts` file compiles, passes every other test, and makes git
 * classify the file as binary — so it has no diff, no blame and no reviewable
 * history, and nobody notices until they try to review a change to it. That is
 * exactly what happened to `core/wrapped/pairings.ts`: a CodeQL autofix
 * correctly replaced a delimiter that could collide, and chose `\0` to do it.
 *
 * The fix was to remove the delimiter entirely. This is here so the next
 * automated fix that reaches for a control character fails a test instead of
 * quietly costing a file its history.
 */
describe('source hygiene', () => {
    const repoRoot = path.resolve(__dirname, '..');

    /** Tracked TypeScript sources, from git so build output is never scanned. */
    const trackedSources = (): string[] =>
        execFileSync(
            'git',
            [
                'ls-files',
                '-z',
                'packages/**/*.ts',
                'apps/**/*.ts',
                'dashboard/src/**/*.ts',
                'dashboard/src/**/*.tsx',
                'test/**/*.ts',
            ],
            { cwd: repoRoot, encoding: 'utf8' }
        )
            .split('\0')
            .filter(Boolean);

    it('has no NUL byte in any TypeScript source', () => {
        const offenders = trackedSources().filter((file) =>
            readFileSync(path.join(repoRoot, file)).includes(0)
        );

        expect(offenders).toEqual([]);
    });

    it('is actually scanning something, so a broken glob cannot pass silently', () => {
        expect(trackedSources().length).toBeGreaterThan(50);
    });
});
