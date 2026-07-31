import { getClientForBot, type BotKey } from './client';

/**
 * Send a user a direct message, and never make that the caller's problem.
 *
 * Diana has had nothing that talks to one person outside an interaction until
 * now. The link sweep needs it: it completes a handshake minutes or hours after
 * the player asked for it, long past any interaction it could reply to.
 *
 * A DM can fail for reasons that are nobody's fault and nothing's bug - closed
 * DMs, no shared server, a blocked bot - so this reports whether it landed
 * rather than throwing. Every caller so far is a background job whose actual
 * work already succeeded.
 */
export async function sendDirectMessage(
    userId: string,
    content: string,
    botKey: BotKey = 'diana'
): Promise<boolean> {
    const client = getClientForBot(botKey);
    if (!client.isReady()) return false;

    try {
        const user = await client.users.fetch(userId);
        await user.send(content);
        return true;
    } catch (error) {
        // Logged at info, not error: "this person does not accept DMs" is a
        // setting, not a failure, and it is the common reason this returns
        // false.
        console.log(
            `[Diana:${botKey}] Could not DM ${userId}: ${(error as Error)?.message ?? error}`
        );
        return false;
    }
}
