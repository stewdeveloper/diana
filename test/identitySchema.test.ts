import { readdirSync, readFileSync } from 'fs';
import path from 'path';

/**
 * Column widths in the identity schema, replayed from the migrations.
 *
 * These are assertions about the *declared* schema rather than about behaviour,
 * because nothing else in this suite can see the schema at all: every identity
 * test mocks `db`, so a column that is too narrow for the values the code puts
 * in it passes all of them and fails in production.
 *
 * That is exactly what happened. 022 keyed `identity_link_challenges` on
 * `(subject_kind, subject_id)` by renaming `discord_user_id`, and a rename keeps
 * the old type — VARCHAR(30), sized for a Discord snowflake. The first Meeps
 * user to open Settings → Connections sent a 36-character UUID and got "Failed
 * to start the link", with `value too long for type character varying(30)` in
 * the log. 024 widened it.
 *
 * The replay is deliberately dumb: it reads the SQL as text, in filename order,
 * and applies the three things the migrations in this repo do to a column
 * (create it, rename it, retype it). It does not understand `DO $$` guards or
 * `IF NOT EXISTS`, and it does not need to — those decide *whether* a statement
 * runs on a given database, not what the column looks like once it has.
 */
describe('identity schema widths', () => {
    const migrationsDir = path.resolve(__dirname, '..', 'db', 'migrations');

    /** Width of a `VARCHAR(n)` column, or null for any other type. */
    type Columns = Map<string, number | null>;

    const columnsOf = (
        schema: Map<string, Columns>,
        table: string
    ): Columns => {
        const existing = schema.get(table);
        if (existing) return existing;
        const fresh: Columns = new Map();
        schema.set(table, fresh);
        return fresh;
    };

    /** `VARCHAR(30)` -> 30; anything else -> null. */
    const widthOf = (type: string): number | null => {
        const match = /^VARCHAR\s*\(\s*(\d+)\s*\)/i.exec(type.trim());
        return match ? Number(match[1]) : null;
    };

    const applyCreates = (sql: string, schema: Map<string, Columns>): void => {
        const creates =
            /CREATE TABLE (?:IF NOT EXISTS )?"(\w+)"\s*\(([\s\S]*?)\n\);/g;
        for (const [, table, body] of sql.matchAll(creates)) {
            const columns = columnsOf(schema, table);
            for (const line of body.split('\n')) {
                const column = /^\s*"(\w+)"\s+(.+)$/.exec(line);
                if (!column) continue;
                columns.set(column[1], widthOf(column[2]));
            }
        }
    };

    const applyAlters = (sql: string, schema: Map<string, Columns>): void => {
        // Each ALTER runs to its own semicolon, including the ones nested in a
        // `DO $$` block, so this finds those too.
        const alters = /ALTER TABLE "(\w+)"\s+([^;]+);/g;
        for (const [, table, action] of sql.matchAll(alters)) {
            const columns = columnsOf(schema, table);

            const renamed = /^RENAME COLUMN "(\w+)" TO "(\w+)"/i.exec(action);
            if (renamed) {
                const [, from, to] = renamed;
                if (columns.has(from)) {
                    columns.set(to, columns.get(from) ?? null);
                    columns.delete(from);
                }
                continue;
            }

            const added =
                /^ADD COLUMN (?:IF NOT EXISTS )?"(\w+)"\s+(.+)$/is.exec(action);
            if (added) {
                columns.set(added[1], widthOf(added[2]));
                continue;
            }

            const retyped = /^ALTER COLUMN "(\w+)" TYPE\s+(.+)$/is.exec(action);
            if (retyped) columns.set(retyped[1], widthOf(retyped[2]));
        }
    };

    /** The schema as it stands after every migration has been applied. */
    const schema = ((): Map<string, Columns> => {
        const built = new Map<string, Columns>();
        const files = readdirSync(migrationsDir)
            .filter((name) => name.endsWith('.sql'))
            .sort();
        for (const file of files) {
            // Normalised, because a checkout on Windows hands these back with
            // CRLF and `.` does not match a carriage return.
            const sql = readFileSync(
                path.join(migrationsDir, file),
                'utf8'
            ).replace(/\r\n/g, '\n');
            applyCreates(sql, built);
            applyAlters(sql, built);
        }
        return built;
    })();

    const width = (table: string, column: string): number | null | undefined =>
        schema.get(table)?.get(column);

    it('reads the migrations it claims to, so a broken parse cannot pass', () => {
        expect(schema.get('identity_accounts')?.size).toBeGreaterThan(3);
        expect(width('identity_accounts', 'external_id')).toBe(200);
        // Renamed by 022. Finding the old name means the rename was not applied.
        expect(width('identity_link_challenges', 'discord_user_id')).toBe(
            undefined
        );
    });

    it('fits a Meeps subject id, which is a UUID and not a snowflake', () => {
        // The value that overflowed: `users.public_id`, a bare UUID.
        const meepsSubjectId = '00000000-0000-4000-8000-000000000000';
        expect(meepsSubjectId).toHaveLength(36);

        const subjectId = width('identity_link_challenges', 'subject_id');
        expect(subjectId).not.toBeNull();
        expect(subjectId).toBeGreaterThanOrEqual(meepsSubjectId.length);
    });

    it('lets any subject that can start a link also finish one', () => {
        // On confirm the subject becomes an attachment, keyed on external_id.
        // A subject_id narrower than that would be a link that opens and then
        // cannot be completed, which is worse than one that never opens.
        expect(width('identity_link_challenges', 'subject_id')).toBe(
            width('identity_accounts', 'external_id')
        );
    });

    it('holds every subject kind the challenge check allows', () => {
        // 'discord_user' and 'meeps_user', the longest being 12.
        expect(
            width('identity_link_challenges', 'subject_kind')
        ).toBeGreaterThanOrEqual('discord_user'.length);
    });
});
