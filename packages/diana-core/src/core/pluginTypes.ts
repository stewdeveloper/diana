import type { Router } from 'express';
import type { EventAdapter } from './eventTypes';

export interface MessageField {
    name: string;
    value: string;
    inline?: boolean;
}

export interface MessagePayload {
    title?: string;
    description?: string;
    url?: string;
    colorHex?: number;
    thumbnailUrl?: string;
    fields?: MessageField[];
    footer?: string;
    timestamp?: string | number | Date;
    text?: string;
    supportUrl?: string;
}

export interface MessageTarget {
    channelId?: string;
}

export interface MessageAdapter {
    sendMessage(target: MessageTarget, payload: MessagePayload): Promise<void>;
}

export interface PluginContext {
    /** Mount an Express router at a path (e.g. '/summoners', '/match') */
    mountRouter(path: string, router: Router): void;
    /** Register a cron-like job (cron expression + handler). Returns a cleanup function. */
    registerCron(schedule: string, handler: () => Promise<void>): () => void;
    /** Get plugin-specific config (from dashboard / plugins config) */
    getConfig<T = Record<string, unknown>>(): T;
    /** Get the shared message adapter (if one is registered). */
    getMessageAdapter(): MessageAdapter | null;
    /**
     * Get the shared event adapter (if one is registered).
     *
     * Structured events for downstream consumers, emitted alongside — never
     * instead of — messages. See ./eventTypes.ts.
     */
    getEventAdapter(): EventAdapter | null;
}

export interface DianaPlugin {
    /** Unique plugin id (e.g. 'diana-league-bot') */
    id: string;
    /** Display name */
    name: string;
    /** Semantic version */
    version: string;
    description?: string;
    /** Optional icon URL or path for the dashboard */
    icon?: string;
    /** Config schema - describes configurable fields for the dashboard */
    configSchema?: ConfigField[];

    /** Called when Diana loads the plugin. Use to register routes, cron. */
    onLoad(context: PluginContext): Promise<void>;
    /** Called when the plugin is enabled (e.g. from dashboard). Start background work here. */
    onEnable?(context: PluginContext): Promise<void>;
    /** Called when the plugin is disabled. Stop background work, clean up. */
    onDisable?(context: PluginContext): Promise<void>;
    /** Called when Diana unloads the plugin. */
    onUnload?(context: PluginContext): Promise<void>;
}

export interface PluginConfigEntry {
    id: string;
    enabled: boolean;
    config?: Record<string, unknown>;
}

/**
 * Describes a single configurable field for a plugin.
 * Used by the dashboard to render a config editor form.
 */
export interface ConfigField {
    /** Key in the config object */
    key: string;
    /** Human-readable label */
    label: string;
    /** Field type - determines the input component */
    type: 'string' | 'number' | 'boolean' | 'array' | 'select' | 'textarea';
    /** Optional description/help text */
    description?: string;
    /** Whether this field is required */
    required?: boolean;
    /** Default value if not set */
    default?: unknown;
    /** For 'select' type: available options */
    options?: { label: string; value: string }[];
    /** For 'array' type: schema for each item in the array */
    arrayItemSchema?: ConfigField[];
}

export type PluginState = 'loaded' | 'enabled' | 'disabled' | 'error';

export interface PluginInfo {
    id: string;
    name: string;
    version: string;
    description?: string;
    icon?: string;
    state: PluginState;
    error?: string;
    config?: Record<string, unknown>;
    configSchema?: ConfigField[];
}
