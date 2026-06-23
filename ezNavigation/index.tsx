import { ApplicationCommandInputType } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { classNameFactory, disableStyle, enableStyle } from "@api/Styles";
import definePlugin, { OptionType } from "@utils/types";
import { closeModal, ModalContent, ModalRoot, ModalSize, openModal } from "@utils/modal";
import type { ModalProps } from "@utils/modal";
import { findStoreLazy } from "@webpack";
import ErrorBoundary from "@components/ErrorBoundary";
import {
    ChannelStore,
    GuildChannelStore,
    GuildMemberStore,
    GuildRoleStore,
    GuildStore,
    NavigationRouter,
    PermissionsBits,
    PermissionStore,
    React,
    SelectedChannelStore,
    SelectedGuildStore,
} from "@webpack/common";

import managedStyle from "./styles.css?managed";

const ChannelMemberStore = findStoreLazy("ChannelMemberStore") as any;

const cl = classNameFactory("vc-guildlisting-");

const CATEGORY_TYPE = 4;
const TEXT_TYPES = [0, 5];

const settings = definePluginSettings({
    enabledGuildIds: {
        type: OptionType.STRING,
        description: "Server IDs the header button shows in. Empty = all servers.",
        default: "1517653713018159225",
    },
    excludedCategoryIds: {
        type: OptionType.STRING,
        description: "Category IDs to exclude from the list (staff/infra). Comma/space separated.",
        default: [
            "1517662077202993264",
            "1517657855589613768",
            "1517653714024927312",
            "1517668547520762156",
            "1517866264708518028",
            "1517664888443633694",
            "1517678390285565992",
            "1517679401062367282",
            "1518978715424653412",
        ].join(", "),
    },
    excludedChannelIds: {
        type: OptionType.STRING,
        description: "Channel IDs to ignore entirely (not a Jump target, not counted). Comma/space separated.",
        default: "1518296565310292110",
    },
    generalMatch: {
        type: OptionType.STRING,
        description: "Channel-name substring to Jump to (falls back to first text channel).",
        default: "general",
    },
    rolePrefix: {
        type: OptionType.STRING,
        description: "Member count = members holding the role named <prefix><category name>, e.g. 'Guild Larper Technology LLC'.",
        default: "Guild ",
    },
    memberCountSource: {
        type: OptionType.SELECT,
        description: "How to count category members.",
        options: [
            { label: "Members with the role (cached)", value: "cached", default: true },
            { label: "Member-list group (online-ish, needs loaded list)", value: "memberList" },
            { label: "Off (hide member count)", value: "off" },
        ],
    },
    hideInaccessible: {
        type: OptionType.BOOLEAN,
        description: "Hide categories you cannot access (no viewable channel to jump to).",
        default: true,
    },
});

interface GuildRecord {
    id: string;
    name: string;
    tag: string;
    order: number;
    memberCount: number | null;
    generalId?: string;
}

function parseIdSet(raw: string): Set<string> {
    return new Set(raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean));
}

function isEnabledGuild(guildId: string | null | undefined): boolean {
    if (!guildId) return false;
    const raw = settings.store.enabledGuildIds.trim();
    if (!raw) return true;
    return parseIdSet(raw).has(guildId);
}

function collectChannels(result: any): any[] {
    const out: any[] = [];
    if (!result) return out;
    for (const key of Object.keys(result)) {
        const v = (result as any)[key];
        if (Array.isArray(v)) for (const e of v) if (e?.channel) out.push(e.channel);
    }
    return out;
}

function makeTag(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return name.trim().slice(0, 2).toUpperCase();
}

function buildGroupCounts(guildId: string): Map<string, number> {
    const counts = new Map<string, number>();
    try {
        const channelId = SelectedChannelStore.getChannelId();
        const props = ChannelMemberStore?.getProps?.(guildId, channelId);
        for (const g of props?.groups ?? []) if (g?.id) counts.set(g.id, g.count);
    } catch { return counts; }
    return counts;
}

function countCachedRole(guildId: string, roleId: string): number {
    try {
        const members = GuildMemberStore.getMembers(guildId) ?? [];
        return members.filter((m: any) => m?.roles?.includes(roleId)).length;
    } catch { return 0; }
}

function memberCountFor(guildId: string, roleId: string | undefined, groups: Map<string, number>): number | null {
    if (!roleId) return null;
    switch (settings.store.memberCountSource) {
        case "off": return null;
        case "memberList": return groups.has(roleId) ? groups.get(roleId)! : countCachedRole(guildId, roleId);
        default: return countCachedRole(guildId, roleId);
    }
}

function canViewChannel(channel: any): boolean {
    if (!channel) return false;
    try {
        return PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel);
    } catch {
        return true;
    }
}

function getGuilds(guildId: string): GuildRecord[] {
    const excludedCats = parseIdSet(settings.store.excludedCategoryIds);
    const excludedChans = parseIdSet(settings.store.excludedChannelIds);
    const channels = collectChannels(GuildChannelStore.getChannels(guildId))
        .filter(c => !excludedChans.has(c.id));

    const catMap = new Map<string, any>();
    for (const c of channels) {
        if (c.type === CATEGORY_TYPE) catMap.set(c.id, c);
    }
    for (const c of channels) {
        if (c.parent_id && !catMap.has(c.parent_id)) {
            const p = ChannelStore.getChannel(c.parent_id);
            if (p && p.type === CATEGORY_TYPE) catMap.set(p.id, p);
        }
    }

    const norm = (s: string) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    const prefix = settings.store.rolePrefix ?? "";
    const roleIdByName = new Map<string, string>();
    const roles = GuildRoleStore.getRolesSnapshot?.(guildId) ?? {};
    for (const r of Object.values<any>(roles)) roleIdByName.set(norm(r.name), r.id);

    const groups = buildGroupCounts(guildId);
    const match = (settings.store.generalMatch || "general").toLowerCase();

    return [...catMap.values()]
        .filter(cat => !excludedCats.has(cat.id) && cat.id !== guildId && (cat.name || "").trim().toLowerCase() !== "uncategorized")
        .map((cat, i): GuildRecord | null => {
            const childMap = new Map<string, any>();
            for (const c of channels) if (c.parent_id === cat.id) childMap.set(c.id, c);
            const children = [...childMap.values()].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
            const texts = children.filter(c => TEXT_TYPES.includes(c.type));
            const general =
                texts.find(c => (c.name ?? "").toLowerCase().includes(match)) ??
                texts[0] ??
                children[0];
            if (settings.store.hideInaccessible && !canViewChannel(general)) return null;
            const roleId =
                roleIdByName.get(norm(prefix + cat.name)) ??
                roleIdByName.get(norm("Guild " + cat.name)) ??
                roleIdByName.get(norm(cat.name));
            return {
                id: cat.id,
                name: cat.name,
                tag: makeTag(cat.name),
                order: typeof cat.position === "number" ? cat.position : i,
                memberCount: memberCountFor(guildId, roleId, groups),
                generalId: general?.id,
            };
        })
        .filter((r): r is GuildRecord => r != null);
}

const ListingIcon = ({ size = 18 }: { size?: number; }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
        <circle cx="4" cy="6" r="1.6" /><rect x="8" y="4.7" width="12" height="2.6" rx="1.3" />
        <circle cx="4" cy="12" r="1.6" /><rect x="8" y="10.7" width="12" height="2.6" rx="1.3" />
        <circle cx="4" cy="18" r="1.6" /><rect x="8" y="16.7" width="12" height="2.6" rx="1.3" />
    </svg>
);

const SearchIcon = ({ size = 16 }: { size?: number; }) => (
    <svg className={cl("search-icon")} width={size} height={size} viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
    </svg>
);

const CloseIcon = () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
);

const GearIcon = () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H2a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 3.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H8a1.65 1.65 0 0 0 1-1.51V2a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.2.61.8 1 1.51 1H22a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
);

const BackIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
);

const COUNT_OPTS = [
    { value: "cached", label: "Cached" },
    { value: "memberList", label: "Member list" },
    { value: "off", label: "Off" },
];

function SettingsRow({ label, desc, control }: { label: string; desc?: string; control: any; }) {
    return (
        <div className={cl("setting")}>
            <div className={cl("setting-label")}>{label}</div>
            {desc && <div className={cl("setting-desc")}>{desc}</div>}
            {control}
        </div>
    );
}

function SettingsView() {
    const s: any = settings.use([
        "enabledGuildIds", "excludedCategoryIds", "excludedChannelIds",
        "generalMatch", "rolePrefix", "memberCountSource", "hideInaccessible",
    ]);

    const textInput = (key: string) => (
        <input
            className={cl("setting-input")}
            value={s[key]}
            spellCheck={false}
            onChange={e => { (settings.store as any)[key] = e.currentTarget.value; }}
        />
    );

    return (
        <div className={cl("settings")}>
            <SettingsRow label="Enabled servers" desc="Server IDs to show the button in. Empty = all servers." control={textInput("enabledGuildIds")} />
            <SettingsRow label="Excluded categories" desc="Category IDs to hide. Comma/space separated." control={textInput("excludedCategoryIds")} />
            <SettingsRow label="Excluded channels" desc="Channel IDs to ignore entirely." control={textInput("excludedChannelIds")} />
            <SettingsRow label="Jump channel match" desc="Channel-name substring to Jump to." control={textInput("generalMatch")} />
            <SettingsRow label="Member-count role prefix" desc="Counts the role named: prefix + category name." control={textInput("rolePrefix")} />
            <SettingsRow
                label="Member count source"
                control={
                    <div className={cl("sort")}>
                        {COUNT_OPTS.map(o => (
                            <button
                                key={o.value}
                                className={cl("sort-btn")}
                                data-active={s.memberCountSource === o.value}
                                onClick={() => { settings.store.memberCountSource = o.value; }}
                            >
                                {o.label}
                            </button>
                        ))}
                    </div>
                }
            />
            <SettingsRow
                label="Hide inaccessible categories"
                desc="Hide categories with no channel you can open."
                control={
                    <button
                        className={cl("toggle")}
                        role="switch"
                        aria-checked={s.hideInaccessible}
                        data-active={s.hideInaccessible}
                        onClick={() => { settings.store.hideInaccessible = !settings.store.hideInaccessible; }}
                    >
                        <span className={cl("toggle-knob")} />
                    </button>
                }
            />
        </div>
    );
}

const SORTS = [
    { key: "default", label: "Default" },
    { key: "name", label: "A–Z" },
] as const;
type SortKey = typeof SORTS[number]["key"];

function jumpToGuild(guildId: string, g: GuildRecord) {
    if (!g.generalId) return;
    const path = `/channels/${guildId}/${g.generalId}`;
    try {
        if ((NavigationRouter as any).transitionToGuild) {
            (NavigationRouter as any).transitionToGuild(guildId, g.generalId);
        } else {
            NavigationRouter.transitionTo(path);
        }
    } catch {
        NavigationRouter.transitionTo(path);
    }
}

let modalKey: string | null = null;
let peeking = false;
let altPressTime = 0;
let comboUsed = false;
let typedSinceOpen = false;
let savedScrollTop = 0;
const TAP_MS = 200;

function GuildListingModal({ modalProps, guildId }: { modalProps: ModalProps; guildId: string; }) {
    const all = React.useMemo(() => getGuilds(guildId), [guildId]);
    const serverName = GuildStore.getGuild(guildId)?.name ?? "this server";

    const [search, setSearch] = React.useState("");
    const [sortKey, setSortKey] = React.useState<SortKey>("default");
    const [sortDir, setSortDir] = React.useState<"asc" | "desc">("asc");
    const [view, setView] = React.useState<"list" | "settings">("list");

    React.useLayoutEffect(() => {
        const el = document.querySelector<HTMLElement>(".vc-guildlisting-content");
        if (el && savedScrollTop > 0) el.scrollTop = savedScrollTop;
    }, []);

    const filtered = React.useMemo(() => {
        const q = search.trim().toLowerCase();
        const list = q ? all.filter(g => g.name.toLowerCase().includes(q)) : all.slice();
        const dir = sortDir === "asc" ? 1 : -1;
        list.sort((a, b) => (sortKey === "name" ? a.name.localeCompare(b.name) : a.order - b.order) * dir);
        return list;
    }, [all, search, sortKey, sortDir]);

    const setSort = (key: SortKey) => {
        if (sortKey === key) setSortDir(d => (d === "asc" ? "desc" : "asc"));
        else { setSortKey(key); setSortDir("asc"); }
    };
    const arrow = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "");

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <div className={cl("header")}>
                <div className={cl("header-icon")} style={{ color: "#fff" }}>
                    {view === "settings" ? <GearIcon /> : <ListingIcon size={20} />}
                </div>
                <div className={cl("titlewrap")}>
                    <h2 className={cl("title")}>
                        {view === "settings" ? "Settings" : "EzNavigation"}
                        {view === "list" && <span className={cl("count")}>{all.length}</span>}
                    </h2>
                    <span className={cl("subtitle")}>
                        {view === "settings" ? "EzNavigation settings" : `Easily navigate between categories inside ${serverName}`}
                    </span>
                </div>
                <div className={cl("header-actions")}>
                    {view === "settings"
                        ? <button onClick={() => setView("list")} aria-label="Back"><BackIcon /></button>
                        : <button onClick={() => setView("settings")} aria-label="Settings"><GearIcon /></button>}
                    <div className={cl("header-divider")} />
                    <button onClick={() => modalProps.onClose()} aria-label="Close"><CloseIcon /></button>
                </div>
            </div>

            <ModalContent className={cl("content")} onScroll={(e: any) => { savedScrollTop = e.currentTarget.scrollTop; }}>
                {view === "settings" ? <SettingsView /> : <>
                <div className={cl("search")}>
                    <SearchIcon />
                    <input
                        className={cl("search-input")}
                        value={search}
                        spellCheck={false}
                        autoFocus
                        placeholder="Search categories…"
                        onChange={e => { setSearch(e.currentTarget.value); typedSinceOpen = true; }}
                    />
                    {search && <span className={cl("search-count")}>{filtered.length}/{all.length}</span>}
                </div>

                <div className={cl("list")}>
                    <div className={cl("list-head")}>
                        <span className={cl("list-label")}>Categories</span>
                        <div className={cl("sort")}>
                            <span className={cl("sort-title")}>Sort</span>
                            {SORTS.map(s => (
                                <button
                                    key={s.key}
                                    className={cl("sort-btn")}
                                    data-active={sortKey === s.key}
                                    onClick={() => setSort(s.key)}
                                >
                                    {s.label}{arrow(s.key)}
                                </button>
                            ))}
                        </div>
                    </div>

                    {filtered.map(g => (
                        <div className={cl("entry")} key={g.id}>
                            <div className={cl("entry-left")}>
                                <div className={cl("avatar-fallback")}>{g.tag}</div>
                                <div className={cl("entry-info")}>
                                    <div className={cl("entry-name")}>{g.name}</div>
                                    {g.memberCount != null && (
                                        <span className={cl("entry-stats")}>
                                            {g.memberCount} {g.memberCount === 1 ? "member" : "members"}
                                        </span>
                                    )}
                                </div>
                            </div>
                            <button
                                className={cl("join")}
                                disabled={!g.generalId}
                                onClick={() => { jumpToGuild(guildId, g); modalProps.onClose(); }}
                            >
                                Jump
                            </button>
                        </div>
                    ))}

                    {filtered.length === 0 && (
                        <div className={cl("empty")}>
                            <div className={cl("empty-icon")}><SearchIcon size={24} /></div>
                            <p>No categories match your search.</p>
                        </div>
                    )}
                </div>
                </>}
            </ModalContent>
        </ModalRoot>
    );
}

function openGuildListing(guildId?: string | null) {
    const id = guildId ?? SelectedGuildStore.getGuildId();
    if (!id || !isEnabledGuild(id) || modalKey) return;
    typedSinceOpen = false;
    modalKey = openModal(props => (
        <ErrorBoundary>
            <GuildListingModal modalProps={props} guildId={id} />
        </ErrorBoundary>
    ), { onCloseCallback: () => { modalKey = null; peeking = false; } });
}

function closeGuildListing() {
    if (!modalKey) return;
    closeModal(modalKey);
    modalKey = null;
    peeking = false;
}

function onGlobalKeyDown(e: KeyboardEvent) {
    if (e.code === "Escape") {
        if (modalKey) closeGuildListing();
        return;
    }
    if (e.code === "AltLeft") {
        if (e.repeat) return;
        if (modalKey) { closeGuildListing(); return; }
        altPressTime = Date.now();
        comboUsed = false;
        openGuildListing();
        peeking = modalKey != null;
        return;
    }
    if (peeking) comboUsed = true;
}

function onGlobalKeyUp(e: KeyboardEvent) {
    if (e.code !== "AltLeft" || !peeking) return;
    peeking = false;
    const heldLong = Date.now() - altPressTime >= TAP_MS;
    const keep = typedSinceOpen || (!heldLong && !comboUsed);
    if (!keep) closeGuildListing();
}

function onWindowBlur() {
    if (peeking) closeGuildListing();
    peeking = false;
}

const HEADER_BTN_ID = "vc-guildlisting-header-btn";
const HEADER_BTN_HTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><circle cx="4" cy="6" r="1.6"/><rect x="8" y="4.7" width="12" height="2.6" rx="1.3"/><circle cx="4" cy="12" r="1.6"/><rect x="8" y="10.7" width="12" height="2.6" rx="1.3"/><circle cx="4" cy="18" r="1.6"/><rect x="8" y="16.7" width="12" height="2.6" rx="1.3"/></svg>';

let headerObserver: MutationObserver | null = null;
let injectScheduled = false;

function injectHeaderButton() {
    const guildId = SelectedGuildStore.getGuildId();
    const header = document.querySelector<HTMLElement>(
        '[class*="headerContent_"]:has([class*="guildDropdown_"])'
    );
    if (!header) return;

    const existing = header.querySelector<HTMLElement>("#" + HEADER_BTN_ID);

    if (!isEnabledGuild(guildId)) { existing?.remove(); return; }
    if (existing) return;

    const btn = document.createElement("div");
    btn.id = HEADER_BTN_ID;
    btn.className = cl("header-btn");
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.setAttribute("aria-label", "EzNavigation");
    btn.innerHTML = HEADER_BTN_HTML;
    btn.addEventListener("click", () => openGuildListing(SelectedGuildStore.getGuildId()));
    header.appendChild(btn);
}

function scheduleDom() {
    if (injectScheduled) return;
    injectScheduled = true;
    requestAnimationFrame(() => {
        injectScheduled = false;
        injectHeaderButton();
    });
}

function startObservers() {
    injectHeaderButton();
    headerObserver = new MutationObserver(scheduleDom);
    headerObserver.observe(document.body, { childList: true, subtree: true });
}

function stopObservers() {
    headerObserver?.disconnect();
    headerObserver = null;
    document.getElementById(HEADER_BTN_ID)?.remove();
}

const EzNavigationPlugin = definePlugin({
    name: "EzNavigation",
    description: "Dupers University: server-header button → searchable category directory with member counts, Jump to #general.",
    authors: [{ name: "statflame", id: 0n }],
    settings,

    commands: [
        {
            name: "categories",
            description: "Open the category listing",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                openGuildListing(ctx?.guild?.id);
            },
        },
    ],

    patches: [],

    start() {
        enableStyle(managedStyle);
        startObservers();
        document.addEventListener("keydown", onGlobalKeyDown);
        document.addEventListener("keyup", onGlobalKeyUp);
        window.addEventListener("blur", onWindowBlur);
    },

    stop() {
        document.removeEventListener("keydown", onGlobalKeyDown);
        document.removeEventListener("keyup", onGlobalKeyUp);
        window.removeEventListener("blur", onWindowBlur);
        closeGuildListing();
        stopObservers();
        disableStyle(managedStyle);
    },
});

export default EzNavigationPlugin;
