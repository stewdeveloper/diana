import type { Request, Response } from 'express';
import { createR6Service } from '../utils/r6ServiceFactory.js';
import {
    getR6PlayerById,
    createR6Player,
    deleteR6Player,
    searchR6PlayerNames,
} from './playerService.js';
import { R6_PLATFORMS } from '../../types.js';

const r6Service = createR6Service();

function normalisePlatform(value: unknown): string | null {
    const platform = String(value ?? 'uplay').toLowerCase();
    return (R6_PLATFORMS as readonly string[]).includes(platform)
        ? platform
        : null;
}

export const getPlayerHandler = async (
    req: Request,
    res: Response
): Promise<void> => {
    const name = String(req.params['name'] ?? '');
    const platform = normalisePlatform(req.params['platform']);
    if (!platform) {
        res.status(400).json({
            error: `platform must be one of ${R6_PLATFORMS.join(', ')}.`,
        });
        return;
    }
    try {
        const profile = await r6Service.getProfileByName(name, platform);
        res.json(profile);
    } catch (err: any) {
        const status = err?.status ?? 500;
        res.status(status).json({
            error: err.message ?? 'Failed to fetch player.',
        });
    }
};

export const addPlayerHandler = async (
    req: Request,
    res: Response
): Promise<void> => {
    const { gameName, platform: rawPlatform } = req.body as {
        gameName?: string;
        platform?: string;
    };
    if (!gameName || !rawPlatform) {
        res.status(400).json({ error: 'gameName and platform are required.' });
        return;
    }
    const platform = normalisePlatform(rawPlatform);
    if (!platform) {
        res.status(400).json({
            error: `platform must be one of ${R6_PLATFORMS.join(', ')}.`,
        });
        return;
    }

    try {
        const profile = await r6Service.getProfileByName(gameName, platform);

        const existing = await getR6PlayerById(profile.ubisoftId);
        if (existing) {
            res.status(409).json({
                error: 'Player already tracked.',
                player: existing,
            });
            return;
        }

        const player = await createR6Player({
            ubisoftId: profile.ubisoftId,
            gameName: profile.gameName,
            platform,
            tier: profile.rank.tier,
            division: profile.rank.division,
            rp: profile.rank.rp,
        });
        res.status(201).json(player);
    } catch (err: any) {
        const status = err?.status ?? 500;
        res.status(status).json({
            error: err.message ?? 'Failed to add player.',
        });
    }
};

export const deletePlayerHandler = async (
    req: Request,
    res: Response
): Promise<void> => {
    const ubisoftId = String(req.params['ubisoftId'] ?? '');
    try {
        const deleted = await deleteR6Player(ubisoftId);
        if (!deleted) {
            res.status(404).json({ error: 'Player not found.' });
            return;
        }
        res.json(deleted);
    } catch (err: any) {
        res.status(500).json({
            error: err.message ?? 'Failed to delete player.',
        });
    }
};

export const searchPlayerNamesHandler = async (
    req: Request,
    res: Response
): Promise<void> => {
    const search = String(req.query.search ?? '');
    const guildId = req.query.guildId ? String(req.query.guildId) : undefined;
    try {
        const names = await searchR6PlayerNames(search, 25, guildId);
        res.json(names);
    } catch (err: any) {
        res.status(500).json({
            error: err.message ?? 'Failed to search players.',
        });
    }
};
