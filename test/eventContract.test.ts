import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    DIANA_EVENT_SCHEMA_VERSION,
    DIANA_EVENT_TYPES,
} from '../packages/diana-core/src/core/eventTypes';

interface GeneratedContract {
    schemaVersion: number;
    eventTypes: string[];
    source: string;
    sourceSha256: string;
}

describe('generated Diana event contract', () => {
    it('matches the authoritative runtime declaration and source hash', () => {
        const contract = JSON.parse(
            readFileSync(
                resolve(__dirname, '../contracts/diana-event/contract.json'),
                'utf8'
            )
        ) as GeneratedContract;
        const source = readFileSync(
            resolve(__dirname, '..', contract.source),
            'utf8'
        );

        expect(contract.schemaVersion).toBe(DIANA_EVENT_SCHEMA_VERSION);
        expect(contract.eventTypes).toEqual([...DIANA_EVENT_TYPES]);
        expect(contract.sourceSha256).toBe(
            createHash('sha256').update(source).digest('hex')
        );
    });
});
