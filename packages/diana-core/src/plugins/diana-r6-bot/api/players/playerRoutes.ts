import { Router } from 'express';
import {
    getPlayerHandler,
    addPlayerHandler,
    deletePlayerHandler,
    searchPlayerNamesHandler,
} from './playerController.js';

export const playerRouter = Router();

/** GET /r6/players/search?search=NAME&guildId=GUILD */
playerRouter.get('/search', searchPlayerNamesHandler);

/** GET /r6/players/:name/:platform */
playerRouter.get('/:name/:platform', getPlayerHandler);

/** POST /r6/players - body: { gameName, platform } */
playerRouter.post('/', addPlayerHandler);

/** DELETE /r6/players/:ubisoftId */
playerRouter.delete('/:ubisoftId', deletePlayerHandler);
