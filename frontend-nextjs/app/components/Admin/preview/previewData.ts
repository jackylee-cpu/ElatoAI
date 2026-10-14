// Example data for the preview pages. None of it is real: the MACs, accounts
// and figures are made up to the scale of the internal test (23 toys). Delete
// each block when its page is built against the database.

import type { Tone } from "./PreviewKit";

export type PreviewDeviceState = "online" | "asleep" | "offline" | "rolledBack" | "unbound";

export const DEVICE_STATES: Record<PreviewDeviceState, [Tone, string]> = {
    online: ["ok", "Online"],
    asleep: ["info", "Asleep"],
    offline: ["idle", "Offline"],
    rolledBack: ["bad", "Update failed"],
    unbound: ["warn", "Unbound"],
};

export interface PreviewDevice {
    name: string;
    mac: string;
    plush: string;
    firmware: string;
    state: PreviewDeviceState;
    lastSeen: string;
    rssi: number | null;
    owner: string | null;
    boundOn: string | null;
    turnsToday: number;
    monthCost: number;
    wifi: string[];
    keyRegistered: string;
    tokenExpires: string;
    rollback?: string;
    heavyUse?: boolean;
}

export const PREVIEW_DEVICES: PreviewDevice[] = [
    { name: "AIBuddy-6270", mac: "D8:3B:DA:4E:62:70", plush: "波波熊", firmware: "1.0.2", state: "online", lastSeen: "just now", rssi: -52, owner: "j***@hkqft.com", boundOn: "10/12", turnsToday: 31, monthCost: 9.8, wifi: ["HKQF-Office", "Jacky iPhone"], keyRegistered: "10/07", tokenExpires: "tomorrow 09:30" },
    { name: "AIBuddy-4234", mac: "D8:3B:DA:4E:42:34", plush: "嘟嘟龍", firmware: "1.0.1", state: "online", lastSeen: "3 min ago", rssi: -61, owner: "m***@hkqft.com", boundOn: "10/12", turnsToday: 18, monthCost: 3.1, wifi: ["Wong-Home-5G"], keyRegistered: "10/07", tokenExpires: "tomorrow 11:02" },
    { name: "AIBuddy-2B84", mac: "D8:3B:DA:51:2B:84", plush: "波波熊", firmware: "1.0.0", state: "rolledBack", lastSeen: "2 h ago", rssi: -74, owner: "k***@example.com", boundOn: "10/12", turnsToday: 23, monthCost: 2.4, wifi: ["Home-5G", "iPhone hotspot"], keyRegistered: "10/07", tokenExpires: "tonight 20:14", rollback: "1.0.1 → 1.0.0" },
    { name: "AIBuddy-6364", mac: "D8:3B:DA:4E:63:64", plush: "嘟嘟龍", firmware: "1.0.1", state: "online", lastSeen: "just now", rssi: -58, owner: "c***@example.com", boundOn: "10/13", turnsToday: 186, monthCost: 11.6, wifi: ["Chan-Family"], keyRegistered: "10/07", tokenExpires: "tomorrow 08:41", heavyUse: true },
    { name: "AIBuddy-1A07", mac: "D8:3B:DA:60:1A:07", plush: "叮叮兔", firmware: "1.0.1", state: "online", lastSeen: "just now", rssi: -49, owner: "l***@example.com", boundOn: "10/13", turnsToday: 27, monthCost: 3.6, wifi: ["Lee_WiFi"], keyRegistered: "10/13", tokenExpires: "tomorrow 10:20" },
    { name: "AIBuddy-3C19", mac: "D8:3B:DA:60:3C:19", plush: "波波熊", firmware: "1.0.1", state: "asleep", lastSeen: "35 min ago", rssi: -66, owner: "w***@example.com", boundOn: "10/13", turnsToday: 12, monthCost: 1.9, wifi: ["Wan-Home"], keyRegistered: "10/13", tokenExpires: "tomorrow 07:55" },
    { name: "AIBuddy-5E22", mac: "D8:3B:DA:60:5E:22", plush: "咪咪貓", firmware: "1.0.2", state: "online", lastSeen: "just now", rssi: -55, owner: "k***@example.com", boundOn: "10/13", turnsToday: 9, monthCost: 1.2, wifi: ["Home-5G"], keyRegistered: "10/13", tokenExpires: "tomorrow 21:03" },
    { name: "AIBuddy-7F40", mac: "D8:3B:DA:60:7F:40", plush: "嘟嘟龍", firmware: "1.0.1", state: "offline", lastSeen: "3 days ago", rssi: null, owner: "h***@example.com", boundOn: "10/13", turnsToday: 0, monthCost: 0.8, wifi: ["Ho-Family-2.4G"], keyRegistered: "10/13", tokenExpires: "expired" },
    { name: "AIBuddy-8D31", mac: "D8:3B:DA:60:8D:31", plush: "波波熊", firmware: "1.0.1", state: "unbound", lastSeen: "5 days ago", rssi: null, owner: null, boundOn: null, turnsToday: 0, monthCost: 0, wifi: [], keyRegistered: "10/13", tokenExpires: "—" },
    { name: "AIBuddy-9B05", mac: "D8:3B:DA:60:9B:05", plush: "跳跳蛙", firmware: "1.0.1", state: "online", lastSeen: "8 min ago", rssi: -63, owner: "t***@example.com", boundOn: "10/13", turnsToday: 22, monthCost: 2.9, wifi: ["Tsang-5G", "Office"], keyRegistered: "10/13", tokenExpires: "tomorrow 12:47" },
];

export const PREVIEW_ACCOUNT = {
    email: "kelly.chan@example.com",
    joined: "2026-10-12",
    login: "Email code",
    pin: "Set",
    dailyLimit: "45 min a day",
    quietHours: "20:30–07:00",
    devices: ["AIBuddy-2B84", "AIBuddy-5E22"],
    events: [
        ["today 12:02", "AIBuddy-2B84 failed to connect 14 times in a row (TLS handshake)"],
        ["today 11:40", "AIBuddy-2B84 did not pass probation on 1.0.1 and rolled back to 1.0.0"],
        ["yesterday 18:40", "Wi-Fi network “iPhone hotspot” added"],
        ["10/13 10:15", "AIBuddy-5E22 bound over Bluetooth"],
    ] as [string, string][],
};

export interface PreviewRelease {
    version: string;
    state: "rolling" | "current" | "old";
    sizeMb: number;
    publishedAt: string;
    notes: string;
    updated: number | null;
    targeted: number | null;
    rolledBack: number | null;
}

export const PREVIEW_RELEASES: PreviewRelease[] = [
    { version: "1.0.2", state: "rolling", sizeMb: 1.71, publishedAt: "10/14 18:00", notes: "C3 TLS fragmentation: free the Opus buffers before the wss connect", updated: 4, targeted: 5, rolledBack: 0 },
    { version: "1.0.1", state: "current", sizeMb: 1.66, publishedAt: "10/12 11:20", notes: "Device secret exchanged for a 24 h token; OTA probation and rollback", updated: 18, targeted: 19, rolledBack: 1 },
    { version: "1.0.0", state: "old", sizeMb: 1.62, publishedAt: "10/08 16:45", notes: "First cloud build", updated: null, targeted: null, rolledBack: null },
];

export const ROLLOUT_STAGES: [string, string][] = [
    ["Internal", "4 allow-listed toys"],
    ["10%", "about 2 toys"],
    ["50%", "about 12 toys"],
    ["100%", "all 23 toys"],
];

export interface PreviewBoard {
    mac: string;
    plush: string | null;
    keyWritten: boolean;
    // mic, speaker, LED, button, Wi-Fi
    selfTest: boolean[] | null;
    failure?: string;
    station: string;
    at: string;
}

export const SELF_TEST_LABELS = ["Mic", "Spk", "LED", "Btn", "WiFi"];

export const PREVIEW_BOARDS: PreviewBoard[] = [
    { mac: "D8:3B:DA:71:04:A1", plush: "波波熊", keyWritten: true, selfTest: [true, true, true, true, true], station: "#2", at: "10:41" },
    { mac: "D8:3B:DA:71:04:A2", plush: "波波熊", keyWritten: true, selfTest: [true, false, true, true, true], failure: "No sound from speaker", station: "#2", at: "10:43" },
    { mac: "D8:3B:DA:71:04:A3", plush: "嘟嘟龍", keyWritten: true, selfTest: [true, true, true, true, true], station: "#1", at: "10:44" },
    { mac: "D8:3B:DA:71:04:A4", plush: "嘟嘟龍", keyWritten: true, selfTest: [true, true, true, true, false], failure: "No Wi-Fi networks found", station: "#1", at: "10:46" },
    { mac: "D8:3B:DA:71:04:A5", plush: "叮叮兔", keyWritten: false, selfTest: null, station: "—", at: "—" },
    { mac: "D8:3B:DA:71:04:A6", plush: null, keyWritten: false, selfTest: null, station: "—", at: "—" },
    { mac: "D8:3B:DA:71:04:A7", plush: null, keyWritten: false, selfTest: null, station: "—", at: "—" },
];

export interface PreviewAuditEntry {
    at: string;
    who: string;
    action: string;
    target: string;
    reason: string;
    diff: ["-" | "+", string][];
}

export const PREVIEW_AUDIT: PreviewAuditEntry[] = [
    { at: "today 14:22", who: "Jacky", action: "Released OTA", target: "1.0.2 → 10%", reason: "Fix C3 TLS fragmentation, two toys first", diff: [["-", "rollout: internal (4 toys)"], ["+", "rollout: 10%"]] },
    { at: "today 11:05", who: "Navy", action: "Edited character", target: "波波熊 · first message", reason: "—", diff: [["-", "first_message: 你好呀！我係波波熊。"], ["+", "first_message: 哈囉！我係波波熊，你今日過得點呀？"]] },
    { at: "yesterday 19:31", who: "Jacky", action: "Changed model", target: "Voice LLM", reason: "R-02 evaluation result", diff: [["-", "llm_model: google/gemma-4-26b"], ["+", "llm_model: deepseek/deepseek-v4-flash"], ["+", "provider.allow_fallbacks: false"]] },
    { at: "10/13 16:10", who: "Jacky", action: "Created account", target: "c***@example.com", reason: "Internal test family", diff: [["+", "account: c***@example.com (parent)"]] },
    { at: "10/13 09:12", who: "Jacky", action: "Granted role", target: "Navy → content admin", reason: "Owns characters and IPs", diff: [["+", "admin_roles: content_admin"]] },
];

// 14 days, oldest first.
export const PREVIEW_DAYS = ["10/01", "10/02", "10/03", "10/04", "10/05", "10/06", "10/07", "10/08", "10/09", "10/10", "10/11", "10/12", "10/13", "10/14"];
export const PREVIEW_ACTIVE = [3, 3, 4, 4, 3, 4, 4, 4, 4, 4, 4, 9, 19, 21];
export const PREVIEW_TURNS = [41, 38, 52, 60, 35, 49, 66, 58, 63, 71, 55, 148, 365, 412];
