import { findByProps, findByPropsAll, findByStoreName } from "@vendetta/metro";
import { instead, after, before } from "@vendetta/patcher";
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

// --- User Models & Safety ---

export function isRealUser(m: any): boolean {
    if (!m || typeof m !== "object" || !m.id) return false;
    if (m.isProvisional) return false;
    const name = m.username || m.global_name || m.globalName;
    if (!name || typeof name !== "string") return false;
    const lower = name.toLowerCase().trim();
    return !(
        lower === "user" ||
        lower === "unknown-user" ||
        lower === "unknown user" ||
        lower === "invalid-user" ||
        lower === "deleted user" ||
        lower === "unknown"
    );
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

    // Server-specific avatar protection (prevents: Cannot convert undefined value to object at hasAvatarForGuild)
    if (!u.guildMemberAvatars || typeof u.guildMemberAvatars !== "object") {
        u.guildMemberAvatars = {};
    }
    if (!u.guild_member_avatars || typeof u.guild_member_avatars !== "object") {
        u.guild_member_avatars = {};
    }

    // Defensive methods to satisfy Discord's User model interface
    if (typeof u.hasAvatarForGuild !== "function") u.hasAvatarForGuild = () => false;
    if (typeof u.hasAnimatedAvatar !== "function") u.hasAnimatedAvatar = () => false;
    if (typeof u.isSystemUser !== "function") u.isSystemUser = () => false;
    if (typeof u.isStaff !== "function") u.isStaff = () => false;
    if (typeof u.isClaimed !== "function") u.isClaimed = () => true;
    if (typeof u.hasFlag !== "function") u.hasFlag = () => false;
    if (typeof u.getAvatarURL !== "function") u.getAvatarURL = () => null;
    if (typeof u.getAvatarSource !== "function") u.getAvatarSource = () => null;
    if (typeof u.hasAvatarDecoration !== "function") u.hasAvatarDecoration = () => false;
    if (typeof u.isVerifiedBot !== "function") u.isVerifiedBot = () => Boolean(u.bot);
    if (typeof u.toString !== "function") u.toString = () => u.username || "User";

    // Standard profile fields
    if (u.banner === undefined) u.banner = null;
    if (u.accentColor === undefined) u.accentColor = null;
    if (u.accent_color === undefined) u.accent_color = null;
    if (u.bio === undefined) u.bio = "";
    if (u.flags === undefined) u.flags = 0;
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

    // 4. Fallback to registered hint
    const hint = getHint(userId);
    if (hint) return hint;

    return u?.username || "User";
}

export function createTombstoneUser(userId: string, hintName?: string): any {
    const isProvisional = !hintName || hintName.toLowerCase() === "user" || /^\d+$/.test(hintName);
    const name = (!hintName || /^\d+$/.test(hintName)) ? "User" : hintName;
    const u = {
        id: String(userId),
        username: name,
        discriminator: "0000",
        avatar: null,
        avatarDecoration: null,
        bot: false,
        system: false,
        globalName: name,
        global_name: name,
        publicFlags: 0,
        flags: 0,
        banner: null,
        accentColor: null,
        bio: "",
        guildMemberAvatars: {},
        guild_member_avatars: {},
        isProvisional,
    };
    return ensureUserProto(u);
}

// --- Storage & State ---

const inFlight = new Set<string>();
const cooldowns = new Map<string, number>();
const knownHints = new Map<string, string>();
const deletedUsers = new Set<string>();
let emitTimer: any = null;
let unpatches: (() => void)[] = [];

function initStorage(): void {
    if (!storage.users || typeof storage.users !== "object") storage.users = {};
    if (!storage.deleted || typeof storage.deleted !== "object") storage.deleted = {};
    if (!storage.hints || typeof storage.hints !== "object") storage.hints = {};

    const now = Date.now();
    for (const id in storage.users) {
        const item = storage.users[id];
        if (!item?.user?.id || now - (item.updatedAt || 0) > 86_400_000) {
            delete storage.users[id];
        }
    }

    for (const id in storage.deleted) {
        deletedUsers.add(id);
    }

    // Clean up any corrupted numerical hints from previous builds
    for (const id in storage.hints) {
        const val = storage.hints[id];
        if (!val || /^\d+$/.test(val) || val.toLowerCase() === "user") {
            delete storage.hints[id];
        } else {
            knownHints.set(id, val);
        }
    }
}

function getHint(id: string): string | undefined {
    return knownHints.get(id) || storage.hints?.[id];
}

function setHint(id: string, name: string): void {
    if (!id || !name) return;
    const cleanName = name.replace(/[*~`]/g, "").trim();
    if (!cleanName || cleanName.toLowerCase() === "user" || /^\d+$/.test(cleanName)) return;

    const previous = knownHints.get(id);
    knownHints.set(id, cleanName);
    if (!storage.hints) storage.hints = {};
    storage.hints[id] = cleanName;

    if (previous !== cleanName) {
        updateCachedMessageMentions(id, cleanName);
        triggerRerender();
    }
}

function updateCachedMessageMentions(userId: string, displayName: string): void {
    try {
        const channelId = SelectedChannelStore?.getChannelId?.();
        if (!channelId) return;
        const raw = MessageStore?.getMessages?.(channelId);
        const msgs = Array.isArray(raw) ? raw : raw?._array || [];
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            if (!m) continue;

            // 1. Direct message content AST
            if (Array.isArray(m.content)) {
                for (let j = 0; j < m.content.length; j++) {
                    const node = m.content[j];
                    if (node && (node.type === "mention" || node.userId === userId || node.id === userId)) {
                        if (node.userId === userId || node.id === userId) {
                            node.content = [{ type: "text", content: "@" + displayName }];
                        }
                    }
                }
            }

            // 2. Embeds AST
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
    }, 50);
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

// --- Event-Driven Publisher & Fetcher ---

function publishUser(user: any): void {
    if (!Dispatcher?.dispatch || !user?.id) return;
    try {
        Dispatcher.dispatch({ type: "USER_UPDATE", user: ensureUserProto(user) });
        Dispatcher.dispatch({ type: "USER_PROFILE_FETCH_FAILURE", userId: user.id });
        triggerRerender();
    } catch { }
}

async function requestUser(userId: string): Promise<void> {
    if (!userId || inFlight.has(userId) || deletedUsers.has(userId)) return;

    const lastFail = cooldowns.get(userId);
    if (lastFail && Date.now() - lastFail < 60_000) return;

    // Check storage cache (TTL 24h)
    const cached = storage.users?.[userId];
    if (cached?.user?.id && isRealUser(cached.user) && Date.now() - (cached.updatedAt || 0) < 86_400_000) {
        publishUser(cached.user);
        return;
    }

    inFlight.add(userId);

    try {
        // 1. UserActions
        if (typeof UserActions?.getUser === "function") {
            try {
                await UserActions.getUser(userId);
                const user = UserStore?.getUser?.(userId);
                if (user?.id && isRealUser(user)) {
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
                    markDeleted(userId);
                    return;
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
                    markDeleted(userId);
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
        } else if (resp.status === 404) {
            markDeleted(userId);
            return;
        }

        cooldowns.set(userId, Date.now());
    } catch {
        cooldowns.set(userId, Date.now());
    } finally {
        inFlight.delete(userId);
    }
}

function saveUser(raw: any): void {
    const user = ensureUserProto(raw);
    if (!storage.users) storage.users = {};
    storage.users[user.id] = { user, updatedAt: Date.now() };

    const displayName = getUserDisplayName(user.id, user);
    if (displayName) {
        updateCachedMessageMentions(user.id, displayName);
    }

    publishUser(user);
}

function markDeleted(userId: string): void {
    deletedUsers.add(userId);
    if (!storage.deleted) storage.deleted = {};
    storage.deleted[userId] = Date.now();

    const hint = getHint(userId);
    const tombstone = createTombstoneUser(userId, hint);
    publishUser(tombstone);
}

// --- Event-Driven Hint Extractor (Universal Embed Scanner) ---

function extractHintsFromEmbed(e: any): void {
    if (!e) return;

    // 1. Author line join/leave hint: e.g. "username has joined the server"
    if (typeof e.author?.name === "string") {
        const m = e.author.name.match(/^(\S+)\s+(?:has\s+)?(?:joined|left|updated)/i);
        if (m) {
            const authorName = m[1].replace(/[*~`]/g, "").trim();
            const desc = `${e.description || ""} ${e.rawDescription || ""}`;
            const idMatch = desc.match(/<@!?(\d{15,21})>/);
            if (idMatch && authorName && authorName.toLowerCase() !== "user" && !/^\d+$/.test(authorName)) {
                setHint(idMatch[1], authorName);
            }
        }
    }

    // 2. Collect ALL text blocks across descriptions and fields
    const blocks: string[] = [];
    if (typeof e.description === "string") blocks.push(e.description);
    if (typeof e.rawDescription === "string" && e.rawDescription !== e.description) blocks.push(e.rawDescription);

    if (Array.isArray(e.fields)) {
        for (let j = 0; j < e.fields.length; j++) {
            const f = e.fields[j];
            if (!f) continue;
            if (typeof f.value === "string") blocks.push(f.value);
            if (typeof f.name === "string" && typeof f.value === "string") {
                blocks.push(`${f.name}\n${f.value}`);
            }
        }
    }

    for (let b = 0; b < blocks.length; b++) {
        const text = blocks[b];
        if (!text) continue;

        const lines = text.split(/\r?\n/);
        let foundName: string | undefined;
        let foundId: string | undefined;

        for (let l = 0; l < lines.length; l++) {
            const cleanLine = lines[l].replace(/[*~`>]/g, "").trim();
            if (!cleanLine) continue;

            // Pattern: Name: _nebegemotik / Username: ... / User: ...
            const nameM = cleanLine.match(/^(?:Name|Username|User|Author):\s*(.+)$/i);
            if (nameM) {
                const rawCandidate = nameM[1].replace(/[*~`]/g, "").trim();
                const cleanCandidate = rawCandidate.replace(/#\d{4}$/, "").trim();
                if (cleanCandidate && cleanCandidate.toLowerCase() !== "user" && !cleanCandidate.startsWith("<@") && !/^\d+$/.test(cleanCandidate)) {
                    foundName = cleanCandidate;
                }
            }

            // Pattern: ID: 1053912510371201054 / User ID: ...
            const idM = cleanLine.match(/(?:ID|User ID):\s*(\d{15,21})/i);
            if (idM) {
                foundId = idM[1];
            }

            // Pattern: Mention: <@1053912510371201054> or just <@1053912510371201054>
            const mentionM = cleanLine.match(/<@!?(\d{15,21})>/);
            if (mentionM && !foundId) {
                foundId = mentionM[1];
            }

            // Pattern: Inline table: "username 1053912510371201054" (MUST start with a letter/underscore!)
            const inlineM = cleanLine.match(/^([a-zA-Z_][a-zA-Z0-9_.\-]*)\s*(?:[|(\[]\s*)?(\d{15,21})/);
            if (inlineM) {
                const tName = inlineM[1].trim();
                const tId = inlineM[2].trim();
                if (tName.toLowerCase() !== "name" && tName.toLowerCase() !== "user" && tName.toLowerCase() !== "id" && !/^\d+$/.test(tName)) {
                    setHint(tId, tName);
                }
            }
        }

        if (foundId && foundName) {
            setHint(foundId, foundName);
        }
    }
}

function extractHintsFromEmbeds(embeds: any[]): void {
    if (!Array.isArray(embeds)) return;
    for (let i = 0; i < embeds.length; i++) {
        extractHintsFromEmbed(embeds[i]);
    }
}

function scanActiveChannelHints(): void {
    try {
        const channelId = SelectedChannelStore?.getChannelId?.();
        if (!channelId) return;
        const raw = MessageStore?.getMessages?.(channelId);
        const msgs = Array.isArray(raw) ? raw : raw?._array || [];
        for (let i = 0; i < msgs.length; i++) {
            if (msgs[i]?.embeds) {
                extractHintsFromEmbeds(msgs[i].embeds);
            }
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

                                // Check if we already have the real resolved user
                                const live = UserStore?.getUser?.(id);
                                const cached = storage.users?.[id]?.user;
                                const realUser = (live && isRealUser(live)) ? live : (cached && isRealUser(cached)) ? cached : null;

                                if (realUser) {
                                    // User is resolved: always format pill with their real name / server nickname!
                                    const displayName = getUserDisplayName(id, realUser);
                                    if (displayName) {
                                        res.content = [{ type: "text", content: "@" + displayName }];
                                    }
                                } else {
                                    // User not yet resolved: trigger reactive fetch
                                    requestUser(id);

                                    // Display hint name in pill immediately if known
                                    const hint = getHint(id);
                                    if (hint) {
                                        res.content = [{ type: "text", content: "@" + hint }];
                                    }
                                }
                            }
                        } catch { }
                        return res;
                    })
                );
            }

            if (typeof rules.mention.react === "function") {
                unpatches.push(
                    before("react", rules.mention, (args) => {
                        try {
                            const [node] = args;
                            if (!node) return;
                            const id = node.userId || node.id;
                            if (!id || !/^\d{15,21}$/.test(id)) return;

                            const live = UserStore?.getUser?.(id);
                            const cached = storage.users?.[id]?.user;
                            const realUser = (live && isRealUser(live)) ? live : (cached && isRealUser(cached)) ? cached : null;

                            if (realUser) {
                                const displayName = getUserDisplayName(id, realUser);
                                if (displayName) {
                                    node.content = [{ type: "text", content: "@" + displayName }];
                                }
                            } else {
                                const hint = getHint(id);
                                if (hint) {
                                    node.content = [{ type: "text", content: "@" + hint }];
                                } else {
                                    requestUser(id);
                                }
                            }
                        } catch { }
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
                if (res && isRealUser(res)) return ensureUserProto(res);

                const [userId] = args;
                if (userId && typeof userId === "string" && /^\d{15,21}$/.test(userId)) {
                    const cached = storage.users?.[userId]?.user;
                    if (cached && isRealUser(cached)) {
                        return ensureUserProto(cached);
                    }

                    // Return safe tombstone/shim so Profile Sheet and <UserMention> never crash!
                    const hint = getHint(userId);
                    return createTombstoneUser(userId, hint);
                }
            } catch { }
            return res;
        })
    );
}

function patchAvatarSafety(unpatches: (() => void)[]): void {
    // 1. Safe default avatar URL fallback
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

    // 2. Defensive User.prototype.hasAvatarForGuild
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

    // 3. Standalone Metro modules exporting hasAvatarForGuild
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
            if (Array.isArray(payload.messages)) {
                for (let i = 0; i < payload.messages.length; i++) {
                    const m = payload.messages[i];
                    if (m?.embeds) extractHintsFromEmbeds(m.embeds);
                }
            } else if (payload.message?.embeds) {
                extractHintsFromEmbeds(payload.message.embeds);
            } else if (payload.type === "CHANNEL_SELECT") {
                scanActiveChannelHints();
                setTimeout(scanActiveChannelHints, 300);
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
        patchAvatarSafety(unpatches);
        patchUserStore(unpatches);
        patchMarkdownRules(unpatches);
        patchFlux(unpatches);

        // Scan current channel for any embed hints
        scanActiveChannelHints();
        setTimeout(scanActiveChannelHints, 300);
    },

    onUnload() {
        for (let i = 0; i < unpatches.length; i++) {
            try { unpatches[i](); } catch { }
        }
        unpatches = [];

        inFlight.clear();
        cooldowns.clear();
        knownHints.clear();
        deletedUsers.clear();

        if (emitTimer) {
            clearTimeout(emitTimer);
            emitTimer = null;
        }
    },
};
