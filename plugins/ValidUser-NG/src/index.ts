import { findByProps, findByPropsAll, findByStoreName } from "@vendetta/metro";
import { instead, after } from "@vendetta/patcher";
import { safeFetch } from "@vendetta/utils";
import { storage } from "@vendetta/plugin";

// --- Metro Modules ---

const Dispatcher = findByProps("_interceptors", "dispatch") || findByProps("dispatch", "subscribe");
const UserStore = findByStoreName("UserStore") || findByProps("getUser", "getCurrentUser");
const MessageStore = findByStoreName("MessageStore") || findByProps("getMessage", "getMessages");
const SelectedChannelStore = findByStoreName("SelectedChannelStore") || findByProps("getChannelId", "getVoiceChannelId");
const SelectedGuildStore = findByStoreName("SelectedGuildStore") || findByProps("getGuildId", "getLastSelectedGuildId");
const GuildMemberStore = findByStoreName("GuildMemberStore") || findByProps("getMember", "getMembers");
const ChannelStore = findByStoreName("ChannelStore") || findByProps("getChannel", "getDMFromUserId");
const RelationshipStore = findByStoreName("RelationshipStore") || findByProps("getNickname");
const AvatarUtils = findByProps("getDefaultAvatarURL", "getUserAvatarURL");
const HTTP = findByProps("getAPIBaseURL") || findByProps("get", "post");
const UserActions = findByProps("getUser", "fetchProfile") || findByProps("fetchProfile");
const AuthToken = findByProps("getToken") || findByProps("token");

// --- Fetch Queue & Concurrency ---

class FetchQueue {
    private concurrency = 3;
    private running = 0;
    private queue: (() => Promise<void>)[] = [];

    push(fn: () => Promise<void>) {
        this.queue.push(fn);
        this.next();
    }

    private next() {
        if (this.running >= this.concurrency || this.queue.length === 0) return;
        const fn = this.queue.shift();
        if (!fn) return;

        this.running++;
        fn().finally(() => {
            this.running--;
            this.next();
        });
    }

    clear() {
        this.queue = [];
        this.running = 0;
    }
}

const queue = new FetchQueue();
const inFlight = new Set<string>();
const cooldowns = new Map<string, number>();
let emitTimer: any = null;
let unpatches: (() => void)[] = [];

// --- User Models & Safety ---

export function isRealUser(m: any): boolean {
    return Boolean(m && typeof m === "object" && m.id && (m.username || m.globalName || m.global_name));
}

export function ensureUserProto(u: any): any {
    if (!u || typeof u !== "object") return u;

    const currentUser = UserStore?.getCurrentUser?.();
    const userProto = currentUser ? Object.getPrototypeOf(currentUser) : null;
    if (userProto && Object.getPrototypeOf(u) === Object.prototype) {
        try {
            Object.setPrototypeOf(u, userProto);
        } catch { }
    }

    // Defensive guild avatars objects to prevent crash in native Hermes
    if (!u.guildMemberAvatars || typeof u.guildMemberAvatars !== "object") {
        u.guildMemberAvatars = {};
    }
    if (!u.guild_member_avatars || typeof u.guild_member_avatars !== "object") {
        u.guild_member_avatars = {};
    }

    // Normalize display names between camelCase and snake_case
    if (!u.globalName && u.global_name) u.globalName = u.global_name;
    if (!u.global_name && u.globalName) u.global_name = u.globalName;

    return u;
}

export function getUserDisplayName(userId: string, user?: any): string {
    // 1. Friend custom nickname
    try {
        const friendNick = RelationshipStore?.getNickname?.(userId);
        if (friendNick && typeof friendNick === "string") return friendNick;
    } catch { }

    // 2. Guild/Server member nickname
    try {
        const channelId = SelectedChannelStore?.getChannelId?.();
        if (channelId) {
            const channel = ChannelStore?.getChannel?.(channelId);
            const guildId = channel?.guild_id || channel?.guildId || SelectedGuildStore?.getGuildId?.();
            if (guildId) {
                const member = GuildMemberStore?.getMember?.(guildId, userId);
                if (member?.nick && typeof member.nick === "string") {
                    return member.nick;
                }
            }
        }
    } catch { }

    // 3. User object: global display name (Pomelo) or username
    const u = user || UserStore?.getUser?.(userId) || storage.users?.[userId]?.user;
    if (u) {
        if (typeof u.globalName === "string" && u.globalName) return u.globalName;
        if (typeof u.global_name === "string" && u.global_name) return u.global_name;
        if (typeof u.username === "string" && u.username) return u.username;
    }

    return `<@${userId}>`;
}

// --- Storage & Cache ---

function initStorage(): void {
    delete storage.hints;
    delete storage.deleted;

    if (!storage.users || typeof storage.users !== "object") {
        storage.users = {};
    }

    const now = Date.now();
    for (const id in storage.users) {
        const item = storage.users[id];
        if (!item?.user?.id || now - (item.updatedAt || 0) > 86_400_000) {
            delete storage.users[id];
        }
    }
}

function restoreCachedUsers(): void {
    if (!storage.users || typeof storage.users !== "object") return;
    const now = Date.now();
    for (const id in storage.users) {
        const entry = storage.users[id];
        if (entry?.user?.id && isRealUser(entry.user) && now - (entry.updatedAt || 0) < 86_400_000) {
            publishUser(entry.user);
        }
    }
}

function updateCachedMessageMentions(userId: string): void {
    try {
        const channelId = SelectedChannelStore?.getChannelId?.();
        if (!channelId) return;

        const user = UserStore?.getUser?.(userId) || storage.users?.[userId]?.user;
        if (!user) return;

        const displayName = getUserDisplayName(userId, user);
        if (!displayName) return;

        const raw = MessageStore?.getMessages?.(channelId);
        const msgs = Array.isArray(raw) ? raw : raw?._array || [];
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            if (!m) continue;

            // Direct message content AST
            if (Array.isArray(m.content)) {
                for (let j = 0; j < m.content.length; j++) {
                    const node = m.content[j];
                    if (node && (node.userId === userId || node.id === userId)) {
                        node.userId = userId;
                        node.content = [{ type: "text", content: "@" + displayName }];
                    }
                }
            }

            // Embeds AST
            if (Array.isArray(m.embeds)) {
                for (let e = 0; e < m.embeds.length; e++) {
                    const emb = m.embeds[e];
                    if (!emb) continue;
                    const props = ["description", "rawDescription", "title", "rawTitle"];
                    for (let p = 0; p < props.length; p++) {
                        const val = emb[props[p]];
                        if (Array.isArray(val)) {
                            for (let j = 0; j < val.length; j++) {
                                const node = val[j];
                                if (node && (node.userId === userId || node.id === userId)) {
                                    node.userId = userId;
                                    node.content = [{ type: "text", content: "@" + displayName }];
                                }
                            }
                        }
                    }
                }
            }
        }
    } catch { }
}

function triggerRerender(): void {
    if (emitTimer) return;
    emitTimer = setTimeout(() => {
        emitTimer = null;
        try {
            MessageStore?.emitChange?.();
        } catch { }
    }, 100);
}

function getAuthToken(): string | null {
    try {
        const t = AuthToken?.getToken?.() || AuthToken?.token;
        if (typeof t === "string" && t.length > 10) return t;
    } catch { }
    try {
        const t = HTTP?.defaults?.headers?.common?.Authorization;
        if (typeof t === "string" && t.length > 10) return t;
    } catch { }
    return null;
}

// --- Fetcher & Publisher ---

function publishUser(user: any): void {
    if (!Dispatcher?.dispatch || !user?.id) return;
    try {
        Dispatcher.dispatch({ type: "USER_UPDATE", user: ensureUserProto(user) });
        Dispatcher.dispatch({ type: "USER_PROFILE_FETCH_FAILURE", userId: user.id });
    } catch { }
}

function fetchUser(userId: string): void {
    if (!userId || inFlight.has(userId)) return;

    // Already loaded in UserStore
    const live = UserStore?.getUser?.(userId);
    if (live && isRealUser(live)) return;

    // Already cached in storage (< 24h)
    const cached = storage.users?.[userId]?.user;
    if (cached && isRealUser(cached) && Date.now() - (storage.users[userId]?.updatedAt || 0) < 86_400_000) {
        publishUser(cached);
        return;
    }

    const lastFail = cooldowns.get(userId);
    if (lastFail && Date.now() - lastFail < 60_000) return;

    inFlight.add(userId);

    queue.push(async () => {
        try {
            await doFetchUser(userId);
        } finally {
            inFlight.delete(userId);
            await new Promise(r => setTimeout(r, 150));
        }
    });
}

async function doFetchUser(userId: string): Promise<void> {
    try {
        // 1. UserActions
        if (typeof UserActions?.getUser === "function") {
            try {
                await UserActions.getUser(userId);
                const user = UserStore?.getUser?.(userId);
                if (user?.id) {
                    saveUser(user);
                    return;
                }
            } catch { }
        }

        // 2. Discord internal HTTP client
        if (typeof HTTP?.get === "function") {
            try {
                const res = await HTTP.get({ url: `/users/${userId}` });
                const raw = res?.body || res;
                if (raw?.id) {
                    saveUser(raw);
                    return;
                }
            } catch (e: any) {
                if (e?.status === 404 || e?.body?.code === 10013) {
                    cooldowns.set(userId, Date.now());
                    return;
                }
                if (e?.status === 429) {
                    const retry = (e?.body?.retry_after ?? 1) * 1000;
                    await new Promise(r => setTimeout(r, retry));
                    return doFetchUser(userId);
                }
            }

            try {
                const res = await HTTP.get(`/users/${userId}`);
                const raw = res?.body || res;
                if (raw?.id) {
                    saveUser(raw);
                    return;
                }
            } catch (e: any) {
                if (e?.status === 404 || e?.body?.code === 10013) {
                    cooldowns.set(userId, Date.now());
                    return;
                }
            }
        }

        // 3. Fallback safeFetch with auth token
        const token = getAuthToken();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers["Authorization"] = token;
        const resp = await safeFetch(`https://discord.com/api/v9/users/${userId}`, { headers });
        if (resp.status === 200) {
            const data = await resp.json();
            if (data?.id) {
                saveUser(data);
                return;
            }
        }

        cooldowns.set(userId, Date.now());
    } catch {
        cooldowns.set(userId, Date.now());
    }
}

function saveUser(raw: any): void {
    const user = ensureUserProto(raw);
    if (!storage.users) storage.users = {};
    storage.users[user.id] = { user, updatedAt: Date.now() };

    publishUser(user);
    updateCachedMessageMentions(user.id);
    triggerRerender();
}

// --- Message Scanner (Extracts IDs & Triggers API Fetch) ---

function scanTextForMentions(text: string): void {
    if (!text || typeof text !== "string") return;
    const regex = /<@!?(\d{15,21})>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        const id = match[1];
        if (id) {
            fetchUser(id);
        }
    }
}

function scanMessage(msg: any): void {
    if (!msg) return;

    if (typeof msg.content === "string") {
        scanTextForMentions(msg.content);
    }

    if (Array.isArray(msg.embeds)) {
        for (let i = 0; i < msg.embeds.length; i++) {
            const emb = msg.embeds[i];
            if (!emb) continue;
            if (typeof emb.title === "string") scanTextForMentions(emb.title);
            if (typeof emb.description === "string") scanTextForMentions(emb.description);
            if (typeof emb.rawDescription === "string") scanTextForMentions(emb.rawDescription);
            if (Array.isArray(emb.fields)) {
                for (let j = 0; j < emb.fields.length; j++) {
                    const f = emb.fields[j];
                    if (typeof f?.name === "string") scanTextForMentions(f.name);
                    if (typeof f?.value === "string") scanTextForMentions(f.value);
                }
            }
        }
    }
}

function scanActiveChannel(): void {
    try {
        const channelId = SelectedChannelStore?.getChannelId?.();
        if (!channelId) return;
        const raw = MessageStore?.getMessages?.(channelId);
        const msgs = Array.isArray(raw) ? raw : raw?._array || [];
        for (let i = 0; i < msgs.length; i++) {
            scanMessage(msgs[i]);
        }
    } catch { }
}

// --- Patches ---

function extractUserId(capture: any, res?: any): string | undefined {
    if (Array.isArray(capture)) {
        for (let i = 1; i < capture.length; i++) {
            const val = capture[i];
            if (typeof val === "string" && /^\d{15,21}$/.test(val)) {
                return val;
            }
        }
        if (typeof capture[0] === "string") {
            const m = capture[0].match(/<@!?(\d{15,21})>/);
            if (m?.[1]) return m[1];
        }
    }
    const fallback = res?.userId || res?.id;
    if (typeof fallback === "string" && /^\d{15,21}$/.test(fallback)) {
        return fallback;
    }
    return undefined;
}

function patchMarkdownRules(unpatches: (() => void)[]): void {
    const mods = [
        ...(findByPropsAll("defaultRules") || []),
        ...(findByPropsAll("rules") || []),
    ];

    const hooked = new Set<any>();

    for (let i = 0; i < mods.length; i++) {
        const rules = mods[i].defaultRules || mods[i].rules;
        if (rules?.mention && !hooked.has(rules.mention)) {
            hooked.add(rules.mention);

            if (typeof rules.mention.parse === "function") {
                unpatches.push(
                    after("parse", rules.mention, (args, res) => {
                        try {
                            const [capture] = args;
                            const id = extractUserId(capture, res);
                            if (id && res) {
                                res.userId = id;
                                res.id = id;

                                const realUser = UserStore?.getUser?.(id) || storage.users?.[id]?.user;
                                if (realUser) {
                                    const displayName = getUserDisplayName(id, realUser);
                                    if (displayName) {
                                        res.content = [{ type: "text", content: "@" + displayName }];
                                    }
                                } else {
                                    res.content = [{ type: "text", content: `<@${id}>` }];
                                    fetchUser(id);
                                }
                            }
                        } catch { }
                        return res;
                    })
                );
            }
        }
    }
}

function patchUserStore(unpatches: (() => void)[]): void {
    if (!UserStore?.getUser) return;

    unpatches.push(
        after("getUser", UserStore, (args, res) => {
            try {
                if (res) return ensureUserProto(res);

                const [userId] = args;
                if (userId && typeof userId === "string" && /^\d{15,21}$/.test(userId)) {
                    const cached = storage.users?.[userId]?.user;
                    if (cached) {
                        return ensureUserProto(cached);
                    }
                    fetchUser(userId);
                }
            } catch { }
            return res;
        })
    );
}

function patchAvatarSafety(unpatches: (() => void)[]): void {
    // Safe default avatar URL fallback
    if (AvatarUtils?.getDefaultAvatarURL) {
        unpatches.push(
            instead("getDefaultAvatarURL", AvatarUtils, (args, orig) => {
                try {
                    const [id] = args;
                    if (typeof id === "string" || typeof id === "number" || id == null) {
                        return orig(...args);
                    }
                    return orig(String(id.id ?? "0"), typeof id.discriminator === "string" ? id.discriminator : "0000");
                } catch {
                    return orig("0", "0000");
                }
            })
        );
    }

    // Defensive User.prototype.hasAvatarForGuild
    const currentUser = UserStore?.getCurrentUser?.();
    const userProto = currentUser ? Object.getPrototypeOf(currentUser) : null;
    if (userProto && typeof userProto.hasAvatarForGuild === "function") {
        unpatches.push(
            instead("hasAvatarForGuild", userProto, function (this: any, args, orig) {
                try {
                    if (!this.guildMemberAvatars || typeof this.guildMemberAvatars !== "object") {
                        this.guildMemberAvatars = {};
                    }
                    if (!this.guild_member_avatars || typeof this.guild_member_avatars !== "object") {
                        this.guild_member_avatars = {};
                    }
                    return orig.apply(this, args);
                } catch {
                    return false;
                }
            })
        );
    }

    // Standalone Metro modules exporting hasAvatarForGuild
    const mods = findByPropsAll("hasAvatarForGuild") || [];
    for (let i = 0; i < mods.length; i++) {
        if (typeof mods[i]?.hasAvatarForGuild === "function") {
            unpatches.push(
                instead("hasAvatarForGuild", mods[i], (args, orig) => {
                    try {
                        const [target] = args;
                        if (target && typeof target === "object") {
                            if (!target.guildMemberAvatars || typeof target.guildMemberAvatars !== "object") {
                                target.guildMemberAvatars = {};
                            }
                            if (!target.guild_member_avatars || typeof target.guild_member_avatars !== "object") {
                                target.guild_member_avatars = {};
                            }
                        }
                        return orig(...args);
                    } catch {
                        return false;
                    }
                })
            );
        }
    }
}

function patchFlux(unpatches: (() => void)[]): void {
    const handlePayload = (payload: any) => {
        try {
            if (!payload) return;

            // Batch messages (LOAD_MESSAGES_SUCCESS, LOCAL_MESSAGES_LOADED, etc.)
            if (Array.isArray(payload.messages)) {
                for (let i = 0; i < payload.messages.length; i++) {
                    scanMessage(payload.messages[i]);
                }
            }

            // Single message (MESSAGE_CREATE, MESSAGE_UPDATE)
            if (payload.message) {
                scanMessage(payload.message);
            }

            // Channel navigation
            if (payload.type === "CHANNEL_SELECT") {
                scanActiveChannel();
                setTimeout(scanActiveChannel, 300);
            }
        } catch { }
    };

    if (typeof Dispatcher?.subscribe === "function") {
        const events = [
            "MESSAGE_CREATE",
            "MESSAGE_UPDATE",
            "LOAD_MESSAGES_SUCCESS",
            "LOAD_MESSAGES_AROUND_SUCCESS",
            "LOCAL_MESSAGES_LOADED",
            "CHANNEL_SELECT",
        ];
        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            Dispatcher.subscribe(ev, handlePayload);
            unpatches.push(() => {
                try { Dispatcher.unsubscribe(ev, handlePayload); } catch { }
            });
        }
    }

    if (Dispatcher && Array.isArray(Dispatcher._interceptors)) {
        Dispatcher._interceptors.unshift(handlePayload);
        unpatches.push(() => {
            const idx = Dispatcher._interceptors?.indexOf(handlePayload);
            if (idx !== -1 && idx != null) Dispatcher._interceptors.splice(idx, 1);
        });
    }
}

// --- Plugin Lifecycle ---

export default {
    onLoad() {
        initStorage();
        restoreCachedUsers();
        patchAvatarSafety(unpatches);
        patchUserStore(unpatches);
        patchMarkdownRules(unpatches);
        patchFlux(unpatches);

        // Initial scan of active channel
        scanActiveChannel();
        setTimeout(scanActiveChannel, 300);
    },

    onUnload() {
        for (let i = 0; i < unpatches.length; i++) {
            try { unpatches[i](); } catch { }
        }
        unpatches = [];

        queue.clear();
        inFlight.clear();
        cooldowns.clear();

        if (emitTimer) {
            clearTimeout(emitTimer);
            emitTimer = null;
        }
    },
};
